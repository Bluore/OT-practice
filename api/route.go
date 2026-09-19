package api

import (
	"encoding/json"
	"net/http"

	otpractice "github.com/Bluore/ot-practice"
	"github.com/Bluore/ot-practice/logger"
	"github.com/Bluore/ot-practice/protocol"
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
	logger.L.Info("join user")

	var initMessage protocol.ClientInitMessage
	for {
		_, rawMessage, err := conn.ReadMessage()
		if err != nil {
			logger.L.Error("error to read message")
			return
		}

		err = json.Unmarshal(rawMessage, &initMessage)
		if err != nil {
			logger.L.Info("error to unmarshal init message")
			continue
		}
		break
	}

	if otpractice.OtClient == nil {
		otpractice.OtClient = otpractice.NewOt()
	}

	connHandler := otpractice.NewConnection(
		conn,
		initMessage.UserID,
		initMessage.UserName,
		otpractice.OtClient,
		r.Context(),
	)

	connHandler.Handle()
}
