package logger

import (
	"go.uber.org/zap"
)

var (
	L *zap.Logger
)

func InitLogger() {
	var err error
	L, err = zap.NewDevelopment()
	if err != nil {
		panic("logger error")
	}
}
