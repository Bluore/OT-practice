package otpractice

import (
	"sync"

	"github.com/Bluore/ot-practice/logger"
	"github.com/Bluore/ot-practice/model"
	"github.com/Bluore/ot-practice/protocol"
	"go.uber.org/zap"
)

var (
	OtClient *Ot
)

type Ot struct {
	Users       map[string]model.User                    `json:"users"`
	Subscribers map[string]chan<- protocol.ServerMessage `json:"-"`

	Content   []byte              `json:"content"`
	Ops       []protocol.Operator `json:"ops"`
	Notify    chan struct{}       `json:"-"`
	UserMu    sync.RWMutex        `json:"-"`
	ContentMu sync.RWMutex        `json:"-"`
	SendMu    sync.Mutex          `json:"-"`
}

func NewOt() *Ot {
	return &Ot{
		Users:       make(map[string]model.User, 100),
		Subscribers: make(map[string]chan<- protocol.ServerMessage, 100),
		Content:     []byte("helloworld"),
		Ops:         make([]protocol.Operator, 0),
		Notify:      make(chan struct{}),
	}
}

func (o *Ot) ConnectUser(userID string, userInfo model.User, subscriber chan<- protocol.ServerMessage) {

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

func (o *Ot) NotifyEdit() {
	o.SendMu.Lock()
	defer o.SendMu.Unlock()

	close(o.Notify)
	o.Notify = make(chan struct{})
}

func (o *Ot) GetNotify() <-chan struct{} {
	o.SendMu.Lock()
	defer o.SendMu.Unlock()

	return o.Notify
}

func (o *Ot) GetReversion() uint32 {
	return uint32(len(o.Ops))
}

func (o *Ot) GetHistory(reversion uint32) (ops []protocol.Operator, newReversion uint32) {
	o.ContentMu.RLock()
	defer o.ContentMu.RUnlock()

	newReversion = o.GetReversion()
	if reversion >= newReversion {
		return nil, reversion
	}

	return o.Ops[reversion:newReversion], newReversion
}

func (o *Ot) GetContent() (content []byte, newReversion uint32) {
	o.ContentMu.RLock()
	defer o.ContentMu.RUnlock()

	return o.Content, o.GetReversion()
}

func (o *Ot) GetUsers() (users []model.User) {
	o.UserMu.RLock()
	defer o.UserMu.RUnlock()

	for _, user := range o.Users {
		users = append(users, user)
	}
	return
}

func (o *Ot) applyEdit(oper *protocol.Operator) {
	var err error

	o.ContentMu.Lock()
	defer o.ContentMu.Unlock()

	if oper.Reversion > uint32(len(o.Ops)) {
		logger.L.Info("reversion if out of ops")
		return
	}

	var operPrime *protocol.Operator
	if oper.Reversion < uint32(len(o.Ops)) {
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

	o.Content = operPrime.Apply(o.Content)
	o.Ops = append(o.Ops, *operPrime)

	o.NotifyEdit()

	logger.L.Info("apply edit", zap.Any("oper", oper), zap.Any("text", o.Content))
}
