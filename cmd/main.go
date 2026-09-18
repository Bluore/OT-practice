package main

import (
	"flag"
	"fmt"
	"net/http"

	api "github.com/Bluore/ot-practice/api"
)

var (
	SERVERPORT = flag.Int("p", 8888, "服务器端口")
)

func main() {
	flag.Parse()

	server := http.Server{
		Addr:    fmt.Sprintf(":%d", *SERVERPORT),
		Handler: api.HandlerRoute(),
	}

	fmt.Printf("server start at: http://localhost:%d\n", *SERVERPORT)
	if err := server.ListenAndServe(); err != nil {
		panic(fmt.Sprintf("server start fail: %v", err))
	}
}
