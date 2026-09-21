package otpractice

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/Bluore/ot-practice/logger"
	"github.com/Bluore/ot-practice/protocol"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

type Connection struct {
	UserID     string
	UserDetail User
	Conn       *websocket.Conn
	Ot         *Ot
	Ctx        context.Context
	UserCxt    context.Context
	Cancel     context.CancelFunc
	Inbox      chan protocol.ClientMessage
	SendMu     sync.Mutex
	Notify     chan struct{}
}

func NewConnection(
	conn *websocket.Conn,
	userID string,
	userName string,
	ot *Ot,
	userCtx context.Context,
) *Connection {
	ctx, cancel := context.WithCancel(context.Background())
	return &Connection{
		UserID: userID,
		UserDetail: User{
			ID:   userID,
			Name: userName,
		},
		Conn:    conn,
		Ot:      ot,
		Ctx:     ctx,
		UserCxt: userCtx,
		Cancel:  cancel,
		Inbox:   make(chan protocol.ClientMessage),
		SendMu:  sync.Mutex{},
	}
}

func (c *Connection) Handle() {
	var sendChannel = make(chan protocol.ServerMessage, 10)
	c.Ot.ConnectUser(c.UserID, c.UserDetail, sendChannel)

	go c.readMessage()

	for {
		// todo check status, history

		select {
		case <-c.Ctx.Done():
			return
		case <-c.UserCxt.Done():
			return
		case <-c.Notify:
			continue
		case message := <-c.Inbox:
			c.handlerMessage(message)
		}
	}

}

func (c *Connection) readMessage() {
	for {
		select {
		case <-c.Ctx.Done():
			return
		case <-c.UserCxt.Done():
			return
		default:
		}

		_, messageRaw, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseAbnormalClosure, websocket.CloseGoingAway) {
				c.Cancel()
				return
			}

			logger.L.Error("error to read msg", zap.Error(err))
			return
		}

		var message protocol.ClientMessage
		err = json.Unmarshal(messageRaw, &message)
		if err != nil {
			logger.L.Info("error to unmarshal msg", zap.Error(err))
			continue
		}

		c.Inbox <- message
	}
}

func (c *Connection) handlerMessage(message protocol.ClientMessage) {
	if message.Edit != nil {
		c.Ot.applyEdit(&message.Edit.Operator)
	}
}
