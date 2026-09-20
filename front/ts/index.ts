import { connectServer, isConnected, sendJson } from "./connontion.js";

/** Backend WebSocket endpoint. */
const SERVER_URL = "ws://localhost:8888/ot";

(function initUserId() {
    const userIdInput = document.getElementById("user_id_input") as HTMLInputElement | null;
    if (userIdInput) {
        userIdInput.value = crypto.randomUUID();
    }
    
    const userNameInput = document.getElementById("user_name_input") as HTMLInputElement | null;
    if (userNameInput) {
        userNameInput.value = "User_" + Math.floor(Math.random() * 1000);
    }
})();

async function pingServer(): Promise<void> {
    try {
        const res = await fetch("/healthy");
        const body = await res.text();
        console.log("ping log: ", body);
        writeLog("ping log: " + res.status + " " + res.statusText + " " + body);
    } catch (err) {
        console.error("ping failed:", err);
        writeLog("ping failed: " + String(err));
    }
}

function linkServer(): void {
    connectServer(SERVER_URL, {
        onOpen: () => writeLog("WebSocket connection established."),
        onMessage: (event) => writeLog("Received message from server: " + String(event.data)),
        onClose: (event) => writeLog(`WebSocket connection closed: ${event.code} ${event.reason}`),
        onError: () => writeLog("WebSocket error, see console for details."),
    });
}

function sendInitMsg(): void {
    if (!isConnected()) {
        console.warn("WebSocket is not connected, please link server first.");
        writeLog("WebSocket is not connected, please link server first.");
        return;
    }

    const userIdInput = document.getElementById("user_id_input") as HTMLInputElement | null;
    const userNameInput = document.getElementById("user_name_input") as HTMLInputElement | null;

    const initMessage = {
        user_id: userIdInput ? userIdInput.value.trim() : "",
        user_name: userNameInput ? userNameInput.value.trim() : "",
    };

    sendJson(initMessage);
    console.log("Init message sent:", initMessage);
    writeLog("Init message sent: " + JSON.stringify(initMessage));
}

/**
 * Write a log line into the logger area.
 * @param message log content; when omitted, the content of #log_input_textarea is used.
 */
function writeLog(message?: string): void {
    const logList = document.getElementById("log_list") as HTMLElement | null;
    const logInput = document.getElementById("log_input_textarea") as HTMLTextAreaElement | null;

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
    logLine.className = "log-line";
    logLine.textContent = "[" + new Date().toLocaleTimeString() + "] " + content;

    logList.insertBefore(logLine, logList.firstChild);
    logList.scrollTop = 0;

    if (fromInput && logInput) {
        logInput.value = "";
        logInput.focus();
    }

    console.log("Log written:", content);
}

/** Clear all log lines in the logger area. */
function clearLog(): void {
    const logList = document.getElementById("log_list") as HTMLElement | null;

    if (!logList) {
        console.warn("Logger area not found, cannot clear log.");
        return;
    }

    logList.innerHTML = "";
    console.log("Log cleared.");
}

// index.html is a classic page whose buttons call these by name, and this file is
// an ES module, so the handlers must be published on window explicitly.
declare global {
    interface Window {
        pingServer: typeof pingServer;
        linkServer: typeof linkServer;
        sendInitMsg: typeof sendInitMsg;
        writeLog: typeof writeLog;
        clearLog: typeof clearLog;
    }
}

window.pingServer = pingServer;
window.linkServer = linkServer;
window.sendInitMsg = sendInitMsg;
window.writeLog = writeLog;
window.clearLog = clearLog;
