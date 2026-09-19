package otpractice

import (
	"sync"

	"github.com/Bluore/ot-practice/logger"
	"github.com/Bluore/ot-practice/protocol"
)

var (
	OtClient *Ot
)

type Ot struct {
	Users       map[string]User                          `json:"users"`
	Subscribers map[string]chan<- protocol.ServerMessage `json:"-"`

	Content []byte              `json:"content"`
	Ops     []protocol.Operator `json:"ops"`
	Mu      sync.Mutex          `json:"-"`
}

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func NewOt() *Ot {
	return &Ot{
		Users:       make(map[string]User, 100),
		Subscribers: make(map[string]chan<- protocol.ServerMessage, 100),
		Content:     []byte("helloworld"),
		Ops:         make([]protocol.Operator, 0),
		Mu:          sync.Mutex{},
	}
}

func (o *Ot) ConnectUser(userID string, userInfo User, subscriber chan<- protocol.ServerMessage) {

	o.Mu.Lock()
	defer o.Mu.Unlock()

	o.Users[userID] = userInfo
	o.Subscribers[userID] = subscriber
}

func (o *Ot) Broadcase(msg protocol.ServerMessage) {
	for _, ch := range o.Subscribers {
		select {
		case ch <- msg:
		default:
			logger.L.Info("error to send msg")
		}
	}
}
