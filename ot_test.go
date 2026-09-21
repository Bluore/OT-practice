package otpractice

import (
	"testing"
	"time"

	"github.com/Bluore/ot-practice/logger"
	"github.com/Bluore/ot-practice/model"
	"github.com/Bluore/ot-practice/protocol"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

func newOt() *Ot {
	ot := NewOt()

	ot.ConnectUser("user_123",
		model.User{
			ID:   uuid.NewString(),
			Name: "user_123",
		},
		newListentMessage(),
	)

	return ot
}

func newListentMessage() chan<- protocol.ServerMessage {
	msgCh := make(chan protocol.ServerMessage, 10)
	go func() {
		for msg := range msgCh {
			logger.L.Info("receive server msg", zap.Any("msg", msg))
		}
	}()
	return msgCh
}

func TestOt_applyEdit(t *testing.T) {
	logger.InitLogger()
	ot := newOt()
	ot.applyEdit(&protocol.Operator{
		Ops: []protocol.OperatorAtomic{
			protocol.NewInsert("helloworld!"),
		},
		Reversion: 0,
	})

	ot.applyEdit(&protocol.Operator{
		Ops: []protocol.OperatorAtomic{
			protocol.NewRetain(5),
			protocol.NewDelete(1),
			protocol.NewRetain(5),
		},
		Reversion: 1,
	})

	ot.applyEdit(&protocol.Operator{
		Ops: []protocol.OperatorAtomic{
			protocol.NewRetain(9),
			protocol.NewDelete(1),
		},
		Reversion: 2,
	})

	logger.L.Info("get content", zap.String("content", string(ot.Content)))

	time.Sleep(time.Millisecond * 100)

	if string(ot.Content) != "helloorld" {
		t.Errorf("string apply error:%s", string(ot.Content))
		t.Fail()
	}

}
