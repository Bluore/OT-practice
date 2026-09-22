import { connectServer, isConnected, sendJson } from "./connontion.js";
import { OtClient, SEP, formatOperatorJson } from "./ot_client.js";
/** Backend WebSocket endpoint. */
const SERVER_URL = "ws://localhost:8888/ot";
/**
 * The local OT session behind the `#edit-area` widgets: it holds the server
 * document, the local text, the two operators that have not been confirmed yet
 * and the server frames waiting to be consumed.
 */
const client = new OtClient();
/** Element ids of the edit area and of the state readout. */
const ID = {
    textarea: "edit_msg_textarea",
    state: "client-state",
};
/** @returns the edit textarea, or null when the page has no edit area. */
function getTextarea() {
    return document.getElementById(ID.textarea);
}
/** @returns the textarea content, or "" when there is no textarea. */
function readTextarea() {
    return getTextarea()?.value ?? "";
}
/** Write `text` into the textarea, keeping the caret where it was if possible. */
function writeTextarea(text) {
    const textarea = getTextarea();
    if (!textarea) {
        return;
    }
    const caret = textarea.selectionStart;
    textarea.value = text;
    const at = Math.min(caret, text.length);
    textarea.setSelectionRange(at, at);
}
/**
 * Refresh the `receive/send/...` readout under the buttons, so the delayed
 * consumption behaviour is visible without opening the log.
 */
function renderState() {
    const state = document.getElementById(ID.state);
    if (!state) {
        return;
    }
    const snapshot = client.getState();
    const send = snapshot.hasSend ? (snapshot.dispatched ? "sent" : "ready") : "none";
    state.textContent =
        `receive=${snapshot.receiveReversion} send=${snapshot.sendReversion}` +
            ` send_operator=${send} wait_operator=${snapshot.hasWait ? "held" : "none"}` +
            ` queued=${snapshot.queued}` +
            (snapshot.desynced ? " desync=yes, re-link to resync" : "");
}
/**
 * Write one logical log entry: the first line is the headline, the remaining
 * ones are its indented details.
 *
 * @param lines log lines, each optionally split on {@link SEP}
 * @param kind headline kind: `"info"`, `"send"`, `"receive"` or `"error"`
 */
function writeLogLines(lines, kind = "info") {
    for (const [index, raw] of lines.entries()) {
        const fields = raw.split(SEP);
        writeLog(fields[0], { kind: index === 0 ? kind : "detail", fields: fields.slice(1) });
    }
}
(function initUserId() {
    const userIdInput = document.getElementById("user_id_input");
    if (userIdInput) {
        userIdInput.value = crypto.randomUUID();
    }
    const userNameInput = document.getElementById("user_name_input");
    if (userNameInput) {
        userNameInput.value = "User_" + Math.floor(Math.random() * 1000);
    }
    renderState();
})();
async function pingServer() {
    try {
        const res = await fetch("/healthy");
        const body = await res.text();
        console.log("ping log: ", body);
        writeLog("ping log: " + res.status + " " + res.statusText + " " + body);
    }
    catch (err) {
        console.error("ping failed:", err);
        writeLog("ping failed: " + String(err), { kind: "error" });
    }
}
/**
 * Open the socket and route every server frame into the local pending queue.
 *
 * The frames are deliberately *not* applied here: `onMessage` only parses and
 * queues, and the "receive operator" button is what consumes the queue.
 */
function linkServer() {
    connectServer(SERVER_URL, {
        onOpen: () => {
            // A fresh socket means a fresh server session: drop the stale
            // revision, the in-flight operators and anything left queued.
            client.reset("", 0);
            writeTextarea("");
            renderState();
            writeLog("WebSocket connection established.", { kind: "info" });
        },
        onMessage: (event) => receiveFrame(String(event.data)),
        onClose: (event) => {
            writeLog(`WebSocket connection closed: ${event.code} ${event.reason}`, { kind: "info" });
        },
        onError: () => writeLog("WebSocket error, see console for details.", { kind: "error" }),
    });
}
/** Parse one raw server frame and park it in the pending queue. */
function receiveFrame(raw) {
    let message;
    try {
        message = JSON.parse(raw);
    }
    catch (err) {
        writeLog("receive failed to parse frame: " + String(err), { kind: "error" });
        return;
    }
    const result = client.enqueue(message);
    writeLogLines(result.lines, result.ok ? "receive" : "error");
    renderState();
}
function sendInitMsg() {
    if (!isConnected()) {
        console.warn("WebSocket is not connected, please link server first.");
        writeLog("WebSocket is not connected, please link server first.", { kind: "error" });
        return;
    }
    const userIdInput = document.getElementById("user_id_input");
    const userNameInput = document.getElementById("user_name_input");
    const initMessage = {
        user_id: userIdInput ? userIdInput.value.trim() : "",
        user_name: userNameInput ? userNameInput.value.trim() : "",
    };
    // The backend reads this as `protocol.ClientInitMessage` before it hands the
    // socket to a Connection, so it must be the first frame after linking.
    client.reset(readTextarea(), 0);
    sendJson(initMessage);
    renderState();
    console.log("Init message sent:", initMessage);
    writeLog("Init message sent: " + JSON.stringify(initMessage), { kind: "send" });
}
/**
 * `calculate operator`: diff the text the operators are based on against the
 * textarea and keep the result for the send button.
 */
function calculateOperator() {
    const result = client.calculate(readTextarea());
    writeLogLines(result.lines, result.ok ? "info" : "error");
    renderState();
}
/**
 * `send operator`: put the held operator on the socket, claiming the confirmed
 * revision as its base.
 *
 * Nothing here has to check for a stale operator: "receive operator" rebases the
 * held operator onto every server operation it merges, so it is always based on
 * the revision this press stamps on the frame. The only guards are "there is
 * something to send" and "it is not already on its way".
 */
function sendOperator() {
    const state = client.getState();
    const operator = client.getSendOperator();
    if (!operator) {
        writeLog('send skipped: nothing calculated, press "calculate operator" first', { kind: "error" });
        return;
    }
    if (state.dispatched) {
        writeLog(line("send skipped: operator is already on its way", `base-revision=${state.receiveReversion}`, 'wait for its echo and press "receive operator"'), { kind: "error" });
        return;
    }
    if (!isConnected()) {
        writeLog("send skipped: WebSocket is not connected, please link server first.", { kind: "error" });
        return;
    }
    const payload = client.buildSendMessage();
    if (!payload) {
        writeLog("send skipped: nothing calculated", { kind: "error" });
        return;
    }
    if (!sendJson(payload.message)) {
        writeLog("send failed: the socket refused the frame", { kind: "error" });
        return;
    }
    client.markSent();
    renderState();
    writeLogLines([
        line("send", `base-revision=${state.receiveReversion}`, `server will reach ${state.sendReversion}`, `base=${payload.operator.baseLength}B`, `target=${payload.operator.targetLength}B`),
        line("  ops ", formatOperatorJson(payload.operator)),
        line("  wire", JSON.stringify(payload.message)),
    ], "send");
}
/**
 * `receive operator`: merge everything the server pushed since the last press.
 *
 * An `edit` frame is replayed operation by operation: a foreign operation is
 * transformed past the two unconfirmed operators before it is merged, and our own
 * operation coming back is recognized as the echo and does not touch the local
 * text at all. An `init` frame replaces the document and the revision outright.
 * The textarea is refreshed to the local text.
 */
function receiveOperator() {
    const pending = client.peekNextFrame();
    if (pending === null) {
        writeLog("receive: no frame queued", { kind: "info" });
        return;
    }
    const result = client.consumePending(readTextarea());
    writeTextarea(client.renderText());
    renderState();
    writeLogLines(result.lines, result.ok ? "receive" : "error");
}
/**
 * Write a log line into the logger area.
 *
 * @param message log content; when omitted, the content of #log_input_textarea
 *   is used.
 * @param options `kind` styles the line, `fields` appends the values that were
 *   on the other side of a {@link SEP} in the original message.
 */
function writeLog(message, options = {}) {
    const logList = document.getElementById("log_list");
    const logInput = document.getElementById("log_input_textarea");
    if (!logList) {
        console.warn("Logger area not found, cannot write log.");
        return;
    }
    const fromInput = typeof message !== "string";
    const content = typeof message === "string"
        ? message.trim()
        : (logInput ? logInput.value.trim() : "");
    if (!content) {
        console.warn("Log content is empty, nothing to write.");
        return;
    }
    const logLine = document.createElement("div");
    logLine.className = "log-line log-" + (options.kind ?? "info");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date().toLocaleTimeString() + " ";
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = content;
    logLine.append(time, text);
    for (const field of options.fields ?? []) {
        const cell = document.createElement("span");
        cell.className = "log-field";
        cell.textContent = field;
        logLine.append(cell);
    }
    logList.insertBefore(logLine, logList.firstChild);
    logList.scrollTop = 0;
    if (fromInput && logInput) {
        logInput.value = "";
        logInput.focus();
    }
    console.log("Log written:", content, options.fields ?? []);
}
/** Clear all log lines in the logger area. */
function clearLog() {
    const logList = document.getElementById("log_list");
    if (!logList) {
        console.warn("Logger area not found, cannot clear log.");
        return;
    }
    logList.innerHTML = "";
    console.log("Log cleared.");
}
/** Build a log line whose fields are rendered as separate aligned cells. */
function line(head, ...fields) {
    return [head, ...fields].join(SEP);
}
window.pingServer = pingServer;
window.linkServer = linkServer;
window.sendInitMsg = sendInitMsg;
window.calculateOperator = calculateOperator;
window.sendOperator = sendOperator;
window.receiveOperator = receiveOperator;
window.writeLog = writeLog;
window.clearLog = clearLog;
//# sourceMappingURL=index.js.map