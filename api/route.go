package api

import (
	"net/http"
	"time"

	"github.com/Bluore/ot-practice/logger"
	"github.com/gorilla/websocket"
)

var (
	fsHandler = http.FileServer(http.Dir("./front"))
	upgrade   = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
)

func HandlerRoute() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthy", healohyHandler)
	mux.Handle("/front/", http.StripPrefix("/front/", fsHandler))
	mux.HandleFunc("/ot", otHandler)

	return mux
}

func healohyHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
	w.Write([]byte("ok"))
}

func otHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrade.Upgrade(w, r, nil)
	if err != nil {
		logger.L.Error("upgrade websocket fail")
	}

	defer conn.Close()

	conn.WriteJSON(map[string]any{
		"code": 200,
	})
	time.Sleep(time.Second)
}
