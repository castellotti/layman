import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import type { ServerMessage, ClientMessage } from '../lib/ws-protocol.js';

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function useWebSocket(): { send: (msg: ClientMessage) => void } {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const {
    setWsStatus,
    setServerVersion,
    addEvent,
    updateEvent,
    addPendingApproval,
    removePendingApproval,
    setAnalyzing,
    setAnalysisError,
    setLaymans,
    setLaymansError,
    setConfig,
    setSessionStatus,
    setSessions,
    markSessionActive,
    markSessionInactive,
  } = useSessionStore();

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'connected':
          setServerVersion(message.serverVersion);
          break;

        case 'event:new':
          addEvent(message.event);
          break;

        case 'event:update':
          updateEvent(message.eventId, message.updates);
          break;

        case 'approval:pending':
          addPendingApproval(message.approval);
          // Show browser notification if tab is not focused
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            void new Notification('Layman: Action needs approval', {
              body: `${message.approval.toolName}: ${JSON.stringify(message.approval.toolInput).slice(0, 100)}`,
              icon: '/favicon.svg',
            });
          }
          break;

        case 'approval:resolved':
          removePendingApproval(message.approvalId);
          break;

        case 'analysis:start':
          setAnalyzing(message.eventId, true);
          break;

        case 'analysis:result':
          setAnalyzing(message.eventId, false);
          updateEvent(message.eventId, { analysis: message.result });
          break;

        case 'analysis:error':
          setAnalyzing(message.eventId, false);
          setAnalysisError(message.eventId, message.error);
          break;

        case 'laymans:start':
          setLaymans(message.eventId, true);
          break;

        case 'laymans:result':
          setLaymans(message.eventId, false);
          updateEvent(message.eventId, { laymans: message.result });
          break;

        case 'laymans:error':
          setLaymans(message.eventId, false);
          setLaymansError(message.eventId, message.error);
          break;

        case 'session:config':
          setConfig(message.config);
          break;

        case 'session:status':
          setSessionStatus(message.status);
          break;

        case 'sessions:list':
          setSessions(message.sessions);
          break;

        case 'session:activated':
          markSessionActive(message.sessionId);
          break;

        case 'session:deactivated':
          markSessionInactive(message.sessionId);
          break;
      }
    },
    [addEvent, addPendingApproval, removePendingApproval, setAnalyzing, setAnalysisError, setLaymans, setLaymansError, setConfig, setServerVersion, setSessionStatus, setSessions, markSessionActive, markSessionInactive, updateEvent]
  );

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    setWsStatus('connecting');

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        setWsStatus('connected');
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          handleMessage(message);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setWsStatus('disconnected');
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        setWsStatus('error');
      };
    } catch {
      setWsStatus('error');
      scheduleReconnect();
    }
  }, [handleMessage, setWsStatus]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    const attempt = reconnectAttemptRef.current;
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttemptRef.current++;
    reconnectTimerRef.current = setTimeout(connect, delay);
  }, [connect]);

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { send };
}
