"""Regenerate the per-state scenario fixtures (handoff §6.1; followup item 7).

    uv run python tests/fixtures/netobs-scenarios/generate.py [scenario ...]

Each scenario is a complete ``net/`` directory (plus ``rules.json`` where the
state involves rules) written by the real gate code: real ``Forwarder``s carry
real connections, and their records go into a real ``Collector`` — the same
``ingest`` → ``NdjsonWriter`` (rotation, gate lifecycle, exit carry-forward,
PolicyWatcher) path as in a deployment. Only two things differ, and neither
changes a record's shape: the collector is fed by a direct call instead of the
unix datagram socket, and upstream dials go to loopback stubs (an origin, an
upstream proxy standing in for gluetun's, SearXNG, an IP-echo service) while
the forwarder is configured with the deployment's names (``host.docker.internal``,
``egress-proxy``, ``searxng``), so records read like a glove-pi-search session.
No DNS is performed; the in-tunnel resolver is a table.

Anything forced rather than organic is listed in README.md ("synthetic"). The
original fixture in ``tests/fixtures/netobs/`` is separate and must stay
byte-identical; nothing here touches it.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import json
import os
import shutil
import ssl
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from glove.netgate import GATE_VERSION, RUN_LOST_AFTER  # noqa: E402
from glove.netgate import writer as writer_mod  # noqa: E402
from glove.netgate.collector import Collector  # noqa: E402
from glove.netgate.exitid import ExitPoller  # noqa: E402
from glove.netgate.forward import EventSink, Forwarder, ForwardSpec  # noqa: E402
from glove.netgate.policy import PolicyWatcher  # noqa: E402
from glove.netgate.records import iso_utc  # noqa: E402
from glove.netgate.resolver import InTunnel  # noqa: E402

OUT = Path(__file__).parent
ENV = SESSION = "pi-search"
IN_TUNNEL = {"en.wikipedia.org": "185.15.59.224", "arxiv.org": "151.101.3.42", "www.nature.com": "151.101.0.95",
             "example.org": "93.184.215.14", "ads.tracker.example": "104.16.99.12",
             "html.duckduckgo.com": "40.114.177.156", "search.brave.com": "143.204.55.93",
             "www.mojeek.com": "5.102.173.68", "api.qwant.com": "51.91.211.16"}
ENGINES = ["html.duckduckgo.com", "search.brave.com", "www.mojeek.com", "api.qwant.com"]
EXIT_ECHO = b'{"ip":"195.177.93.17","country":"Switzerland","city":null,"latitude":47.3643,"longitude":8.5437}'
EXIT_URL = "https://am.i.mullvad.net/json"


# --- stubs (loopback only) ---------------------------------------------------------


def client_hello(name: str) -> bytes:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    out = ssl.MemoryBIO()
    obj = ctx.wrap_bio(ssl.MemoryBIO(), out, server_hostname=name)
    with contextlib.suppress(ssl.SSLWantReadError):
        obj.do_handshake()
    return out.read()


async def serve(handler) -> tuple[asyncio.Server, int]:
    s = await asyncio.start_server(handler, "127.0.0.1", 0)
    return s, s.sockets[0].getsockname()[1]


def origin(total: int, chunk: int = 16384, pace: float = 0.3, linger: float = 0.0):
    """Reads the request, sends `total` bytes in paced chunks, then (after
    `linger` seconds of silence — a pooled connection) closes."""

    async def h(r, w):
        with contextlib.suppress(ConnectionError):
            await r.read(65536)
            sent = 0
            while sent < total:
                n = min(chunk, total - sent)
                w.write(b"x" * n)
                await w.drain()
                sent += n
                await asyncio.sleep(pace)
            await asyncio.sleep(linger)
        w.close()

    return h


def upstream_proxy(table: dict[str, int], refuse: set[str] = frozenset()):
    """Stands in for the egress proxy (gluetun's): CONNECT or absolute-form GET
    to a host in `table` reaches that loopback port; anything else is a 502."""

    async def h(r, w):
        try:
            head = await r.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, ConnectionError):
            w.close()
            return
        method, target, _ = head.split(b"\r\n")[0].decode().split(" ")
        host = (target.rsplit(":", 1)[0] if method == "CONNECT"
                else target.split("://")[1].split("/")[0].rsplit(":", 1)[0])
        if host in refuse or host not in table:
            w.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            await w.drain()
            w.close()
            return
        o_r, o_w = await asyncio.open_connection("127.0.0.1", table[host])
        if method == "CONNECT":
            w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        o_w.write(b"GET / HTTP/1.1\r\n\r\n")

        async def pipe(a, b):
            with contextlib.suppress(ConnectionError):
                while d := await a.read(65536):
                    b.write(d)
                    await b.drain()
            b.close()

        await asyncio.gather(pipe(o_r, w), pipe(r, o_w), return_exceptions=True)

    return h


def echo():
    async def h(r, w):
        await r.readuntil(b"\r\n\r\n")
        w.write(b"HTTP/1.0 200 OK\r\n\r\n" + EXIT_ECHO)
        await w.drain()
        w.close()

    return h


class TableResolver:
    """Stands in for gluetun's DNS: answers from IN_TUNNEL (no network)."""

    source = "dns://gluetun:53"

    async def lookup(self, name):
        return IN_TUNNEL.get(name), 60


class DownResolver:
    """gluetun's DNS unreachable (the tunnel's resolver is down)."""

    source = "dns://gluetun:53"

    async def lookup(self, name):
        raise ConnectionRefusedError(111, "Connection refused")


# --- the gate under test --------------------------------------------------------------


class LoopbackForwarder(Forwarder):
    """A real Forwarder whose configured upstream (a deployment name) is dialled
    on a loopback stub instead: the one substitution in these fixtures."""

    def __init__(self, *a, dial_port: int, **k):
        super().__init__(*a, **k)
        self._dial_port = dial_port

    async def _dial_upstream(self):
        return await asyncio.open_connection("127.0.0.1", self._dial_port)


SERVICES = {
    "llm": {"service": "llm", "listen": "glove-pi-search-llm:8080", "observed": True, "harness": True,
            "mode": "tcp", "tool": "llm", "scope": "local", "upstream": "tcp:host.docker.internal:8080",
            "route": {"kind": "tcp", "upstream": "tcp:host.docker.internal:8080"}, "client": "harness"},
    "search": {"service": "search", "listen": "glove-pi-search-search:8080", "observed": True, "harness": True,
               "mode": "tcp", "tool": "web_search", "scope": "local", "upstream": "tcp:searxng:8080",
               "route": {"kind": "tcp", "upstream": "tcp:searxng:8080"}, "client": "harness"},
    "proxy": {"service": "proxy", "listen": "glove-pi-search-proxy:8888", "observed": True, "harness": True,
              "mode": "http-proxy", "tool": "web_fetch", "scope": None, "upstream": "chain:http://egress-proxy:8888",
              "route": {"kind": "vpn", "upstream": "http://egress-proxy:8888"}, "client": "harness"},
    "fanout": {"service": "fanout", "listen": "glove-pi-search-fanout:8899", "observed": True, "harness": False,
               "mode": "http-proxy", "tool": "search-engine-fanout", "scope": None, "client": "searxng",
               "upstream": "chain:http://egress-proxy:8888",
               "route": {"kind": "vpn", "upstream": "http://egress-proxy:8888"}},
    "browser": {"service": "browser", "listen": "glove-pi-search-browser:3001", "observed": False, "harness": True},
}


class Scenario:
    """One scenario directory: session.json (as glove renders it), a real
    Collector writing net/, and forwarders feeding it."""

    def __init__(self, name: str, *, route: str = "vpn", record: str = "metadata", record_headers: bool = False,
                 exit_identity: bool = True, rotate: dict | None = None, rules: dict | None = None):
        self.dir = OUT / name
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        self.route = route
        self.record, self.record_headers = record, record_headers
        services = json.loads(json.dumps(list(SERVICES.values())))
        for s in services:
            if s.get("route", {}).get("kind") == "vpn":
                s["route"]["kind"] = route
        self.facts = {
            "v": 1, "type": "session", "env": ENV, "session": SESSION, "harness": "pi", "gate": GATE_VERSION,
            "image": f"glove/netgate:{GATE_VERSION}-0000000000", "record": record, "resolve": "in-tunnel",
            "resolver": "dns://gluetun:53",
            "exit_identity": f"via-proxy:{EXIT_URL}" if exit_identity else "none",
            "upstream_kind": route,
            "rotate": {"max_bytes": 67108864, "keep": 8, "retain_s": None, **(rotate or {})},
            "record_headers": record_headers, "rendered_at": iso_utc(), "services": services,
        }
        (self.dir / "session.json").write_text(json.dumps(self.facts, indent=2) + "\n")
        self.rules_path = self.dir / "rules.json"
        if rules is not None:
            self.write_rules(rules)
        self.col = Collector(self.dir, "/nonexistent", rules_path=self.rules_path)
        self.col._write_own("start")
        self.sink = EventSink(None)
        self.sink.send = self._send
        self.live = True
        self.fwds: list[Forwarder] = []
        self.servers: list[asyncio.Server] = []

    def _send(self, rec: dict) -> bool:
        if self.live:
            self.col.ingest(json.dumps(rec, separators=(",", ":")).encode())
        return True

    def write_rules(self, doc: dict) -> None:
        tmp = self.rules_path.with_name("rules.json.gen.tmp")
        tmp.write_text(json.dumps(doc, indent=2) + "\n")
        os.replace(tmp, self.rules_path)

    async def stub(self, handler) -> int:
        server, port = await serve(handler)
        self.servers.append(server)
        return port

    async def forwarder(self, service: str, dial_port: int, *, policy: bool = False, **kw) -> Forwarder:
        s = SERVICES[service]
        host, port = s["upstream"].split("//")[-1].removeprefix("tcp:").rsplit(":", 1)
        spec = ForwardSpec(
            service=service, listen_port=0, listen_host="127.0.0.1", upstream_host=host, upstream_port=int(port),
            env=ENV, session=SESSION, tool=s["tool"], scope=s["scope"] or "local", mode=s["mode"],
            route_kind=self.route if s["mode"] == "http-proxy" else "tcp", client=s["client"] if not s["harness"]
            else "unknown", record=self.record, record_headers=self.record_headers,
            resolver_url="dns://gluetun:53" if s["mode"] == "http-proxy" else None,
        )
        timing = {k: kw.pop(k) for k in ("policy_poll", "head_timeout", "update_interval") if k in kw}
        timing.setdefault("update_interval", 0.5)
        fwd = LoopbackForwarder(spec, self.sink, dial_port=dial_port,
                                policy=PolicyWatcher(self.rules_path, env=ENV, session=SESSION) if policy else None,
                                **timing)
        if s["mode"] == "http-proxy":
            fwd.resolver = InTunnel(kw.pop("resolver", TableResolver()))
        await fwd.start()
        if s["harness"]:
            fwd._ingress = frozenset({"127.0.0.1"})  # connections arrive on the internal-network ingress
        self.fwds.append(fwd)
        return fwd

    async def exit_poll(self, proxy_port: int) -> ExitPoller:
        poller = ExitPoller(url=EXIT_URL, kind=self.route, tls=False,
                            dial=lambda: asyncio.open_connection("127.0.0.1", proxy_port),
                            emit=self._send, env=ENV, session=SESSION)
        await poller.poll_once()
        return poller

    async def snapshot(self) -> None:
        """End a *running* scenario: status as of now, then stop feeding the
        collector, so flows still open stay open in the files."""
        await asyncio.sleep(0.3)  # let closes already under way land
        self.col.write_status("running")
        self.live = False
        await self._teardown()
        self.col.writer.close()
        self.col.exits.close()

    async def stop_cleanly(self) -> None:
        """End a *stopped* scenario the way `glove down` does: forwarders first
        (each cuts its flows: gate_shutdown closes, then its `stop`), then the
        collector (its `stop`, status.json state "stopped")."""
        await self._teardown()
        self.live = False
        self.col._write_own("stop")
        self.col.writer.close()
        self.col.exits.close()
        self.col.write_status("stopped")

    async def _teardown(self) -> None:
        for f in self.fwds:
            await f.stop()
        for s in self.servers:
            s.close()


# --- clients ----------------------------------------------------------------------------


async def connect(port: int, host: str, *, hello: bool = True, hold: float | None = None) -> None:
    """A harness CONNECT through the proxy gate; reads to EOF (or holds)."""
    r, w = await asyncio.open_connection("127.0.0.1", port)
    head = f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode()
    w.write(head + (client_hello(host) if hello else b""))
    await w.drain()
    try:
        if hold is not None:
            await asyncio.sleep(hold)
        else:
            await r.read()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        w.close()


async def send(port: int, data: bytes, *, then_wait: float = 0.0) -> bytes:
    r, w = await asyncio.open_connection("127.0.0.1", port)
    if data:
        w.write(data)
        await w.drain()
    if then_wait:
        await asyncio.sleep(then_wait)
    try:
        out = await r.read()
    except ConnectionError:
        out = b""
    w.close()
    return out


def rules_doc(*rules, default: str = "allow") -> dict:
    return {"v": 1, "env": ENV, "session": SESSION, "updated_at": iso_utc(), "updated_by": "layman",
            "default": default, "rules": list(rules)}


# --- scenarios --------------------------------------------------------------------------


async def web(sc: Scenario, *, refuse: set[str] = frozenset(), total: int = 64 * 1024, **fkw):
    """An origin behind a stub egress proxy, and the proxy gate in front of it."""
    o = await sc.stub(origin(total))
    table = {**dict.fromkeys(IN_TUNNEL, o), "am.i.mullvad.net": await sc.stub(echo())}
    proxy_port = await sc.stub(upstream_proxy(table, set(refuse)))
    fwd = await sc.forwarder("proxy", proxy_port, **fkw)
    return fwd, proxy_port


async def default_block():
    sc = Scenario("default-block", rules=rules_doc(
        {"id": "r_01M3SCENALLOWWIKI000000000", "action": "allow", "match": {"host": "en.wikipedia.org"},
         "note": "the one allowed destination"}, default="block"))
    fwd, _ = await web(sc, policy=True)
    await connect(fwd.port, "en.wikipedia.org")  # allowed by the rule
    await connect(fwd.port, "arxiv.org")  # no rule matched: the default blocks it (rule: null)
    await sc.snapshot()


async def direct():
    sc = Scenario("direct", route="direct", exit_identity=False)
    fwd, _ = await web(sc)
    await connect(fwd.port, "en.wikipedia.org")  # leaves with no tunnel: scope "direct"
    await send(fwd.port, b"CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n")  # refused before leaving: "local"
    await sc.snapshot()


async def rules_rejected():
    good = rules_doc({"id": "r_01M3SCENTRACKERS0000000000", "action": "block",
                      "match": {"host": "*.tracker.example"}, "note": "ads"})
    sc = Scenario("rules-rejected", rules=good)
    fwd, _ = await web(sc, policy=True, policy_poll=0.05)
    sc.col.write_status("running")  # the collector accepts (and reports) the good file
    bad = {**rules_doc({"id": "r_01M3SCENTRACKERS0000000000", "action": "block",
                        "match": {"host": "*.tracker.example"}}), "exec": "rm -rf /"}
    sc.write_rules(bad)  # a writer's bad change: an unknown key rejects the whole file
    await asyncio.sleep(0.3)
    await send(fwd.port, b"CONNECT ads.tracker.example:443 HTTP/1.1\r\n\r\n")  # last good set still enforced
    await connect(fwd.port, "en.wikipedia.org")
    await sc.snapshot()


async def terminate():
    sc = Scenario("terminate")
    o = await sc.stub(origin(2 * 1024 * 1024, pace=0.2))  # a long download
    proxy_port = await sc.stub(upstream_proxy(dict.fromkeys(IN_TUNNEL, o)))
    fwd = await sc.forwarder("proxy", proxy_port, policy=True, policy_poll=0.05)
    job = asyncio.create_task(connect(fwd.port, "arxiv.org"))
    await asyncio.sleep(1.3)  # established and updating
    sc.write_rules(rules_doc({"id": "r_01M3SCENCUTARXIV0000000000", "action": "block",
                              "match": {"host": "arxiv.org"}, "terminate": True, "note": "cut it now"}))
    await asyncio.wait_for(job, 3)
    await sc.snapshot()


async def resolver_down():
    sc = Scenario("resolver-down")
    fwd, _ = await web(sc, resolver=DownResolver())
    await connect(fwd.port, "en.wikipedia.org")  # still works: the upstream proxy resolves in-tunnel itself
    await connect(fwd.port, "www.nature.com")
    await sc.snapshot()


async def telemetry_dropped():
    sc = Scenario("telemetry-dropped")
    fwd, _ = await web(sc)
    await connect(fwd.port, "en.wikipedia.org")
    real_write = os.write
    target = {"fd": None}

    def full(fd, data):  # the collector's disk fills up for a while (injected ENOSPC)
        if fd == sc.col.writer._fd or fd == target["fd"]:
            target["fd"] = fd
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_write(fd, data)

    writer_mod.os.write = full
    try:
        with open(os.devnull, "w") as null, contextlib.redirect_stderr(null):  # the collector logs the drop
            await connect(fwd.port, "arxiv.org")
    finally:
        writer_mod.os.write = real_write
    await connect(fwd.port, "www.nature.com")  # recovered
    await sc.snapshot()


async def record_full():
    sc = Scenario("record-full", record="full", record_headers=True)
    fwd, _ = await web(sc)
    await send(fwd.port, b"GET http://example.org/robots.txt?lang=en HTTP/1.1\r\nHost: example.org\r\n"
                         b"User-Agent: pi-web-fetch/0.1\r\nAccept: text/plain\r\n"
                         b"Authorization: Bearer sk-live-SECRET\r\nCookie: session=SECRET\r\n\r\n")
    await connect(fwd.port, "en.wikipedia.org")  # HTTPS: method CONNECT, url null
    await sc.snapshot()


async def exit_none():
    sc = Scenario("exit-none", exit_identity=False)
    fwd, _ = await web(sc)
    await connect(fwd.port, "en.wikipedia.org")
    await sc.snapshot()


async def exit_unhealthy():
    sc = Scenario("exit-unhealthy")
    fwd, proxy_port = await web(sc)
    poller = await sc.exit_poll(proxy_port)  # healthy first
    await connect(fwd.port, "en.wikipedia.org")
    down = await sc.stub(upstream_proxy({}, set()))  # then the tunnel stops answering
    poller.dial = lambda: asyncio.open_connection("127.0.0.1", down)
    await poller.poll_once()
    await sc.snapshot()


async def pooled():
    sc = Scenario("pooled")
    o_llm = await sc.stub(origin(32 * 1024, pace=0.2, linger=60))  # replies, then idles: kept alive
    llm = await sc.forwarder("llm", o_llm)
    fwd, _ = await web(sc, total=200 * 1024)
    held = asyncio.create_task(send(llm.port, client_hello("llm.operator.lan")))
    await asyncio.sleep(1.0)  # its bytes stop changing here, so the gate emits no more updates
    await connect(fwd.port, "arxiv.org")  # meanwhile other traffic runs for > 3 s
    await sc.snapshot()
    held.cancel()


async def sni_refined():
    sc = Scenario("sni-refined")
    o = await sc.stub(origin(48 * 1024, pace=0.2))
    llm = await sc.forwarder("llm", o)
    r, w = await asyncio.open_connection("127.0.0.1", llm.port)
    await asyncio.sleep(0.6)  # silent past SNI_WAIT: `open` goes out with the configured target
    w.write(client_hello("llm.operator.lan"))  # then the SNI: later records carry it
    await w.drain()
    await r.read()
    w.close()
    await asyncio.sleep(0.1)
    await sc.snapshot()


async def rotation():
    sc = Scenario("rotation", rotate={"max_bytes": 6000, "keep": 8})
    o = await sc.stub(origin(96 * 1024, pace=0.25))
    proxy_port = await sc.stub(upstream_proxy(dict.fromkeys(IN_TUNNEL, o)))
    fwd = await sc.forwarder("proxy", proxy_port)
    long = asyncio.create_task(connect(fwd.port, "arxiv.org"))  # open here, close files later
    await asyncio.sleep(0.8)
    frozen = time.time()
    sc.col.writer._clock = lambda: frozen  # force two rotations in one millisecond: `…Z` then `…Z-1`
    for _ in range(12):
        await send(fwd.port, b"CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n")  # guard refusals: quick, small
    sc.col.writer._clock = time.time
    await long
    await sc.snapshot()


async def empty():
    sc = Scenario("empty")
    fwd, _ = await web(sc, head_timeout=0.5)
    _, w = await asyncio.open_connection("127.0.0.1", fwd.port)  # connect, send nothing, close: eof
    w.close()
    await w.wait_closed()
    await asyncio.sleep(0.1)
    await send(fwd.port, b"", then_wait=0.8)  # connect and idle past the head timeout: timeout
    await connect(fwd.port, "en.wikipedia.org")
    await sc.snapshot()


async def search():
    sc = Scenario("search")
    o = await sc.stub(origin(24 * 1024, pace=0.1))
    proxy_port = await sc.stub(upstream_proxy(dict.fromkeys(IN_TUNNEL, o)))
    fanout = await sc.forwarder("fanout", proxy_port)

    async def searxng(r, w):  # one web_search: SearXNG fans out to its engines, then answers
        await r.read(65536)
        await asyncio.gather(*(connect(fanout.port, e) for e in ENGINES))
        w.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n"
                b'{"results": [ ]}\n')
        await w.drain()
        w.close()

    search_fwd = await sc.forwarder("search", await sc.stub(searxng))
    await send(search_fwd.port, b"GET /search?q=glove&format=json HTTP/1.1\r\nHost: searxng:8080\r\n\r\n")
    await sc.snapshot()


async def stopped():
    sc = Scenario("stopped")
    o_llm = await sc.stub(origin(64 * 1024, pace=0.3))
    llm = await sc.forwarder("llm", o_llm)
    fwd, proxy_port = await web(sc, total=4 * 1024 * 1024)
    await sc.exit_poll(proxy_port)
    await send(llm.port, client_hello("llm.operator.lan"))
    job = asyncio.create_task(connect(fwd.port, "arxiv.org"))  # still running at `glove down`
    await asyncio.sleep(1.2)
    await sc.stop_cleanly()
    job.cancel()
    await asyncio.gather(job, return_exceptions=True)


async def gate_lost():
    sc = Scenario("gate-lost")
    o = await sc.stub(origin(4 * 1024 * 1024, pace=0.3))
    proxy_port = await sc.stub(upstream_proxy(dict.fromkeys(IN_TUNNEL, o)))
    fwd = await sc.forwarder("proxy", proxy_port)
    job = asyncio.create_task(connect(fwd.port, "arxiv.org"))
    await asyncio.sleep(1.2)
    # The forwarder is SIGKILLed: from here nothing of it reaches the collector
    # (no close, no `stop`, no heartbeat), and Docker does not restart it.
    fwd.sink = EventSink(None)
    later = time.monotonic() + RUN_LOST_AFTER + 1  # ...and the collector's clock moves past the heartbeat
    sc.col._clock = lambda: later
    await sc.snapshot()  # its status tick writes the inferred `stop`
    job.cancel()
    await asyncio.gather(job, return_exceptions=True)


SCENARIOS = {
    "default-block": default_block, "direct": direct, "rules-rejected": rules_rejected, "terminate": terminate,
    "resolver-down": resolver_down, "telemetry-dropped": telemetry_dropped, "record-full": record_full,
    "exit-none": exit_none, "exit-unhealthy": exit_unhealthy, "pooled": pooled, "sni-refined": sni_refined,
    "rotation": rotation, "empty": empty, "search": search, "stopped": stopped, "gate-lost": gate_lost,
}


if __name__ == "__main__":
    names = sys.argv[1:] or list(SCENARIOS)
    for name in names:
        asyncio.run(SCENARIOS[name]())
        files = sorted(p.name for p in (OUT / name).iterdir())
        print(f"{name:<18} {' '.join(files)}")
