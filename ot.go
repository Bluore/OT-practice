package otpractice

import (
	"sync"

	"github.com/Bluore/ot-practice/logger"
	"github.com/Bluore/ot-practice/protocol"
	"go.uber.org/zap"
)

var (
	OtClient *Ot
)

type Ot struct {
	Users       map[string]User                          `json:"users"`
	Subscribers map[string]chan<- protocol.ServerMessage `json:"-"`

	Content   []byte              `json:"content"`
	Ops       []protocol.Operator `json:"ops"`
	UserMu    sync.Mutex          `json:"-"`
	ContentMu sync.Mutex          `json:"-"`
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
		UserMu:      sync.Mutex{},
		ContentMu:   sync.Mutex{},
	}
}

func (o *Ot) ConnectUser(userID string, userInfo User, subscriber chan<- protocol.ServerMessage) {

	o.UserMu.Lock()
	defer o.UserMu.Unlock()

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

func (o *Ot) applyEdit(oper *protocol.Operator) {
	var err error

	o.ContentMu.Lock()
	defer o.ContentMu.Unlock()

	if oper.Reversion > len(o.Ops) {
		logger.L.Info("reversion if out of ops")
		return
	}

	var operPrime *protocol.Operator
	if oper.Reversion < len(o.Ops) {
		operPrime = oper
		for _, historyOper := range o.Ops[oper.Reversion:] {
			operPrime, _, err = operPrime.Transform(&historyOper)
			if err != nil {
				logger.L.Error("transform error:unsupport operator")
				return
			}
		}
	} else {
		operPrime = oper
	}

	o.Ops = append(o.Ops, *operPrime)
	o.Content = operPrime.Apply(o.Content)

	logger.L.Info("apply edit", zap.Any("oper", oper), zap.Any("text", o.Content))
}
