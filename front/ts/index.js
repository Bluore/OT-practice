import { connectServer, isConnected, sendJson } from "./connontion.js";
/** Backend WebSocket endpoint. */
const SERVER_URL = "ws://localhost:8888/ot";
(function initUserId() {
    const userIdInput = document.getElementById("user_id_input");
    if (userIdInput) {
        userIdInput.value = crypto.randomUUID();
    }
    const userNameInput = document.getElementById("user_name_input");
    if (userNameInput) {
        userNameInput.value = "User_" + Math.floor(Math.random() * 1000);
    }
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
        writeLog("ping failed: " + String(err));
    }
}
function linkServer() {
    connectServer(SERVER_URL, {
        onOpen: () => writeLog("WebSocket connection established."),
        onMessage: (event) => writeLog("Received message from server: " + String(event.data)),
        onClose: (event) => writeLog(`WebSocket connection closed: ${event.code} ${event.reason}`),
        onError: () => writeLog("WebSocket error, see console for details."),
    });
}
function sendInitMsg() {
    if (!isConnected()) {
        console.warn("WebSocket is not connected, please link server first.");
        writeLog("WebSocket is not connected, please link server first.");
        return;
    }
    const userIdInput = document.getElementById("user_id_input");
    const userNameInput = document.getElementById("user_name_input");
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
function writeLog(message) {
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
function clearLog() {
    const logList = document.getElementById("log_list");
    if (!logList) {
        console.warn("Logger area not found, cannot clear log.");
        return;
    }
    logList.innerHTML = "";
    console.log("Log cleared.");
}
window.pingServer = pingServer;
window.linkServer = linkServer;
window.sendInitMsg = sendInitMsg;
window.writeLog = writeLog;
window.clearLog = clearLog;
//# sourceMappingURL=index.js.map