package api

import "net/http"

var (
	fsHandler = http.FileServer(http.Dir("./front"))
)

func HandlerRoute() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthy", healohyHandler)
	mux.Handle("/front/", http.StripPrefix("/front/", fsHandler))

	return mux
}

func healohyHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
	w.Write([]byte("ok"))
}
