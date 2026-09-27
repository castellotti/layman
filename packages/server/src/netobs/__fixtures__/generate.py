"""Regenerate the sample net/ directory Layman builds against.

    uv run python tests/fixtures/netobs/generate.py

Every record is produced by the real gate code (glove.netgate), in-process on
loopback — nothing is hand-written — covering each state a UI must render:
an LLM flow over TLS (SNI-derived host, local scope), tunnelled web_fetch
CONNECTs to several hosts (with in-tunnel IPs from a stub resolver standing in
for gluetun's DNS), an exit.ndjson record from the real exit poller, a
plain-http absolute-form fetch, SSRF-guard
refusals, a user-rule block (with the rules.json that caused it), a malformed
request, an upstream that could not reach its
destination, and a flow cut by gate shutdown. Loopback addresses are then
rewritten to the service names they stand in for, so the fixture reads like a
glove-pi-search session. No DNS is performed (names map to loopback in a table).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from glove.netgate import GATE_VERSION  # noqa: E402
from glove.netgate.collector import Collector  # noqa: E402
from glove.netgate.exitid import ExitPoller  # noqa: E402
from glove.netgate.forward import EventSink, Forwarder, ForwardSpec  # noqa: E402
from glove.netgate.policy import PolicyWatcher  # noqa: E402

OUT = Path(__file__).parent
ENV = SESSION = "pi-search"
HOSTS = ["en.wikipedia.org", "arxiv.org", "www.nature.com", "duckduckgo.com"]
ENGINES = ["html.duckduckgo.com", "search.brave.com", "www.mojeek.com", "api.qwant.com"]  # SearXNG fan-out
# What the in-tunnel resolver answers (documentation / plausible public addresses).
IN_TUNNEL = {"en.wikipedia.org": "185.15.59.224", "arxiv.org": "151.101.3.42",
             "www.nature.com": "151.101.0.95", "example.org": "93.184.215.14",
             "html.duckduckgo.com": "40.114.177.156", "search.brave.com": "143.204.55.93",
             "www.mojeek.com": "5.102.173.68", "api.qwant.com": "51.91.211.16"}
EXIT_ECHO = b'{"ip":"195.177.93.17","country":"Switzerland","city":null,"latitude":47.3643,"longitude":8.5437}'
USER_RULE = "r_01M3FIXTUREADSBLOCK00000000"  # a stable id, as Layman or the CLI would write
RULES = {"v": 1, "env": ENV, "session": SESSION, "updated_at": "2026-09-23T04:20:00.000Z",
         "updated_by": "layman", "default": "allow",
         "rules": [{"id": USER_RULE, "action": "block", "match": {"host": "*.tracker.example"}, "note": "ads"}]}


class Capture(EventSink):
    def __init__(self):
        super().__init__(None)
        self.records: list[dict] = []

    def send(self, record):
        self.records.append(record)
        return True


def hello(name: str) -> bytes:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    out = ssl.MemoryBIO()
    obj = ctx.wrap_bio(ssl.MemoryBIO(), out, server_hostname=name)
    with contextlib.suppress(ssl.SSLWantReadError):
        obj.do_handshake()
    return out.read()


async def origin(n: int):
    async def h(r, w):
        await r.read(65536)
        for _ in range(n // 16384):
            w.write(b"x" * 16384)
            await w.drain()
            await asyncio.sleep(0.3)
        w.close()

    s = await asyncio.start_server(h, "127.0.0.1", 0)
    return s, s.sockets[0].getsockname()[1]


async def upstream_proxy(table: dict[str, int], refuse: set[str]):
    async def h(r, w):
        head = await r.readuntil(b"\r\n\r\n")
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
            while d := await a.read(65536):
                b.write(d)
                await b.drain()
            b.close()

        await asyncio.gather(pipe(o_r, w), pipe(r, o_w), return_exceptions=True)

    s = await asyncio.start_server(h, "127.0.0.1", 0)
    return s, s.sockets[0].getsockname()[1]


async def talk(port: int, data: bytes, *, hold: float = 0.0) -> None:
    r, w = await asyncio.open_connection("127.0.0.1", port)
    w.write(data)
    await w.drain()
    if hold:
        await asyncio.sleep(hold)
        w.close()
        return
    await r.read()
    w.close()


class StubResolver:
    """Stands in for gluetun's DNS: answers from IN_TUNNEL (no network at all)."""

    source = "dns://gluetun:53"

    async def lookup(self, name):
        return IN_TUNNEL.get(name), 60


async def echo_server():
    async def h(r, w):
        await r.readuntil(b"\r\n\r\n")
        w.write(b"HTTP/1.0 200 OK\r\n\r\n" + EXIT_ECHO)
        await w.drain()
        w.close()

    s = await asyncio.start_server(h, "127.0.0.1", 0)
    return s, s.sockets[0].getsockname()[1]


async def main(rules_path: Path) -> list[dict]:
    llm_origin, llm_port = await origin(96 * 1024)
    web_origin, web_port = await origin(160 * 1024)
    echo, echo_port = await echo_server()
    table = {**dict.fromkeys([*HOSTS, *ENGINES, "example.org"], web_port), "am.i.mullvad.net": echo_port}
    proxy, proxy_port = await upstream_proxy(table, {"duckduckgo.com"})
    sink = Capture()
    base = {"env": ENV, "session": SESSION, "listen_host": "127.0.0.1", "listen_port": 0}
    llm = Forwarder(ForwardSpec(service="llm", tool="llm", scope="local", upstream_host="127.0.0.1",
                                upstream_port=llm_port, **base), sink, update_interval=0.5)
    fetch = Forwarder(ForwardSpec(service="proxy", tool="web_fetch", mode="http-proxy", route_kind="vpn",
                                  upstream_host="127.0.0.1", upstream_port=proxy_port, **base),
                      sink, update_interval=0.5, policy=PolicyWatcher(rules_path, env=ENV, session=SESSION))
    from glove.netgate.resolver import InTunnel

    fetch.resolver = InTunnel(StubResolver())
    fanout = Forwarder(ForwardSpec(service="fanout", tool="search-engine-fanout", mode="http-proxy",
                                   route_kind="vpn", client="searxng", upstream_host="127.0.0.1",
                                   upstream_port=proxy_port, **base), sink, update_interval=0.5)
    fanout.resolver = InTunnel(StubResolver())
    exit_poller = ExitPoller(url="https://am.i.mullvad.net/json", kind="vpn", tls=False,
                             dial=lambda: asyncio.open_connection("127.0.0.1", proxy_port),
                             emit=sink.send, env=ENV, session=SESSION)
    await llm.start()
    await fetch.start()
    await fanout.start()
    await exit_poller.poll_once()
    jobs = [talk(llm.port, hello("llm.operator.lan"))]
    for h in HOSTS:
        jobs.append(talk(fetch.port, f"CONNECT {h}:443 HTTP/1.1\r\nHost: {h}:443\r\n\r\n".encode() + hello(h)))
    jobs += [
        talk(fetch.port, b"GET http://example.org/robots.txt HTTP/1.1\r\nHost: example.org\r\n\r\n"),
        talk(fetch.port, b"CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n"),
        talk(fetch.port, b"CONNECT gluetun:8000 HTTP/1.1\r\n\r\n"),
        talk(fetch.port, b"GET /not-a-proxy-request HTTP/1.1\r\n\r\n"),
        talk(fetch.port, b"CONNECT ads.tracker.example:443 HTTP/1.1\r\n\r\n"),
        # one web_search: the search service (tcp, local) plus SearXNG's own fan-out
        *[talk(fanout.port, f"CONNECT {e}:443 HTTP/1.1\r\n\r\n".encode() + hello(e)) for e in ENGINES],
    ]
    await asyncio.gather(*jobs)
    # a long download still running when the gate is stopped
    long_job = asyncio.create_task(talk(fetch.port, b"CONNECT arxiv.org:443 HTTP/1.1\r\n\r\n" + hello("arxiv.org"),
                                        hold=5))
    await asyncio.sleep(1.2)
    await llm.stop()
    await fetch.stop()
    await fanout.stop()
    long_job.cancel()
    for s in (llm_origin, web_origin, proxy, echo):
        s.close()
    return sink.records


def rewrite(records: list[dict], llm_port: str, proxy_port: str) -> list[dict]:
    text = json.dumps(records)
    text = text.replace(f'"tcp:127.0.0.1:{llm_port}"', '"tcp:host.docker.internal:8080"')
    text = text.replace(f'"http://127.0.0.1:{proxy_port}"', '"http://egress-proxy:8888"')
    return json.loads(text)


if __name__ == "__main__":
    rules_path = OUT / "rules.json"
    rules_path.write_text(json.dumps(RULES, indent=2) + "\n")  # the control file, as Layman would write it
    captured = asyncio.run(main(rules_path))
    exits = [r for r in captured if r.get("type") == "exit"]
    recs = [r for r in captured if r.get("type") == "flow"]
    llm_up = next(r["route"]["upstream"] for r in recs if r["service"] == "llm").rsplit(":", 1)[1]
    proxy_up = next(r["route"]["upstream"] for r in recs if r["service"] == "proxy").rsplit(":", 1)[1]
    recs = rewrite(recs, llm_up, proxy_up)
    for r in recs:
        # In a deployment these arrive on the internal network's ingress alias
        # (labelled `harness`, as the live runs show); in-process there is none.
        if r["service"] != "fanout":
            r["client"] = "harness"
        if r["service"] == "llm":  # the loopback origin's port stands in for the LLM port
            r["dest"]["port"] = 8080
    recs.sort(key=lambda r: (r["t"], r["phase"] != "open"))
    (OUT / "flows.ndjson").write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in recs))
    (OUT / "exit.ndjson").write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in exits))

    session = {
        "v": 1, "type": "session", "env": ENV, "session": SESSION, "harness": "pi", "gate": GATE_VERSION,
        "image": f"glove/netgate:{GATE_VERSION}-0000000000", "record": "metadata", "resolve": "in-tunnel",
        "resolver": "dns://gluetun:53", "exit_identity": "via-proxy:https://am.i.mullvad.net/json",
        "upstream_kind": "vpn", "rendered_at": recs[0]["t"], "rotate": {"max_bytes": 67108864, "keep": 8},
        "services": [
            {"service": "llm", "listen": "glove-pi-search-llm:8080", "observed": True, "mode": "tcp",
             "tool": "llm", "scope": "local", "upstream": "tcp:host.docker.internal:8080",
             "route": {"kind": "tcp", "upstream": "tcp:host.docker.internal:8080"}},
            {"service": "search", "listen": "glove-pi-search-search:8080", "observed": True, "mode": "tcp",
             "tool": "web_search", "scope": "local", "upstream": "tcp:searxng:8080",
             "route": {"kind": "tcp", "upstream": "tcp:searxng:8080"}},
            {"service": "proxy", "listen": "glove-pi-search-proxy:8888", "observed": True, "mode": "http-proxy",
             "tool": "web_fetch", "scope": None, "upstream": "chain:http://egress-proxy:8888",
             "route": {"kind": "vpn", "upstream": "http://egress-proxy:8888"}},
            {"service": "fanout", "listen": "glove-pi-search-fanout:8899", "observed": True, "harness": False,
             "mode": "http-proxy", "tool": "search-engine-fanout", "scope": None, "client": "searxng",
             "upstream": "chain:http://egress-proxy:8888",
             "route": {"kind": "vpn", "upstream": "http://egress-proxy:8888"}},
            {"service": "browser", "listen": "glove-pi-search-browser:3001", "observed": False},
        ],
    }
    (OUT / "session.json").write_text(json.dumps(session, indent=2) + "\n")

    col = Collector(OUT, "/nonexistent", rules_path=rules_path)
    col.facts = session
    for r in recs:
        col._track_upstream(r)
    col.writer.written = len(recs)
    col.policy.poll()  # as write_status() does in the running collector
    col._resolver["proxy"] = True  # the gate reported a healthy in-tunnel resolver
    status = col.status("running")
    status["t"] = recs[-1]["t"]
    (OUT / "status.json").write_text(json.dumps(status, indent=2) + "\n")
    print(f"wrote {len(recs)} flow records, {len(exits)} exit, session.json, status.json, rules.json to {OUT}")
