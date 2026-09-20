/**
 * WebSocket connection layer.
 *
 * This module owns the socket state and knows nothing about the UI: callers pass
 * callbacks in, so index.ts -> connontion.ts stays a one-way dependency.
 */
export interface WsHandlers {
    /** Called after the socket is open. */
    onOpen?: (event: Event) => void;
    /** Called for every message pushed by the server. */
    onMessage?: (event: MessageEvent) => void;
    /** Called when the socket is closed by either side. */
    onClose?: (event: CloseEvent) => void;
    /** Called on transport errors. */
    onError?: (event: Event) => void;
}

/** Current socket, or null when never connected / already closed. */
export let ws: WebSocket | null = null;

/**
 * Open a connection to `url`, reusing the current socket when it is still alive.
 * @param url WebSocket endpoint, e.g. ws://localhost:8888/ot
 * @param handlers optional callbacks invoked for socket lifecycle events
 * @returns the socket that is now tracked as the current connection
 */
export function connectServer(url: string, handlers: WsHandlers = {}): WebSocket {
    const current = ws;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
        console.warn("WebSocket is already connected, reuse the current connection.");
        return current;
    }

    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = (event) => {
        console.log("WebSocket connection established.");
        handlers.onOpen?.(event);
    };

    socket.onmessage = (event) => {
        console.log("Received message from server:", event.data);
        handlers.onMessage?.(event);
    };

    socket.onclose = (event) => {
        console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
        if (ws === socket) {
            ws = null;
        }
        handlers.onClose?.(event);
    };

    socket.onerror = (event) => {
        console.error("WebSocket error:", event);
        handlers.onError?.(event);
    };

    return socket;
}

/** Close the current socket, if any. */
export function closeServer(): void {
    const socket = ws;
    if (!socket) {
        return;
    }
    ws = null;
    socket.close();
}

/** @returns true when the current socket is open and ready to send. */
export function isConnected(): boolean {
    const socket = ws;
    return socket !== null && socket.readyState === WebSocket.OPEN;
}

/**
 * Send one JSON payload over the current connection.
 * @returns false when there is no open connection, so nothing was sent.
 */
export function sendJson(payload: unknown): boolean {
    const socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
}
