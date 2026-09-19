"use strict";
var ws;
(function () {
    var userIdInput = document.getElementById("user_id_input");
    if (userIdInput) {
        userIdInput.value = crypto.randomUUID();
    }
})();
function pingServer() {
    fetch("/healthy").then((res) => {
        console.log("ping log: ", res.text());
    });
}
function linkServer() {
    ws = new WebSocket("ws://localhost:8888/ot");
    ws.onopen = () => {
        console.log("WebSocket connection established.");
    };
    ws.onmessage = (event) => {
        console.log("Received message from server:", event.data);
    };
}
function sendInitMsg() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("WebSocket is not connected, please link server first.");
        return;
    }
    var userIdInput = document.getElementById("user_id_input");
    var userNameInput = document.querySelector(".user_name_input");
    var userId = userIdInput ? userIdInput.value.trim() : "";
    var userName = userNameInput ? userNameInput.value.trim() : "";
    if (!userId || !userName) {
        console.warn("user id / user name cannot be empty.");
        userNameInput?.focus();
        return;
    }
    var initMessage = {
        user_id: userId,
        user_name: userName
    };
    ws.send(JSON.stringify(initMessage));
    console.log("Init message sent:", initMessage);
}
