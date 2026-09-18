

function pingServer() {
    fetch("/healthy").then((res) => {
        console.log("ping log: ",res.text());
    });
}

function linkServer() {
    let ws = new WebSocket("ws://localhost:8888/ot");
    ws.onopen = () => {
        console.log("WebSocket connection established.");
    }
    
    ws.onmessage = (event) => {
        console.log("Received message from server:", event.data);
    };
    
    ws.OPEN
}
