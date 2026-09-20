package protocol

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/Bluore/ot-practice/logger"
)

func initLogger() {
	logger.InitLogger()
}

func TestTransform_InsertAndInsert(t *testing.T) {
	initLogger()
	aOp := Operator{
		Ops: []OperatorAtomic{
			NewInsert("world"),
			NewRetain(5),
		},
		Reversion: 0,
	}
	bOp := Operator{
		Ops: []OperatorAtomic{
			NewInsert("hello"),
			NewRetain(5),
		},
		Reversion: 0,
	}

	aPrime, bPrime, _ := aOp.Transform(&bOp)
	aEncode, _ := json.Marshal(aPrime)
	bEncode, _ := json.Marshal(bPrime)
	logger.L.Info(string(aEncode))
	logger.L.Info(string(bEncode))

	oriText := []byte("12345")
	aText := string(bPrime.Apply(aOp.Apply(oriText)))
	bText := string(aPrime.Apply(bOp.Apply(oriText)))

	if string(aText) != string(bText) {
		t.Errorf("aText != bText\naText:%s\nbText:%s\n", string(aText), string(bText))
		return
	}
	logger.L.Info(fmt.Sprintf("transform success:%s", aText))
}

func TestTransform_DeleteAndDelete(t *testing.T) {
	initLogger()
	aOp := Operator{
		Ops: []OperatorAtomic{
			NewDelete(1),
			NewRetain(9),
		},
		Reversion: 0,
	}
	bOp := Operator{
		Ops: []OperatorAtomic{
			NewDelete(2),
			NewRetain(8),
		},
		Reversion: 0,
	}

	aPrime, bPrime, _ := aOp.Transform(&bOp)
	aEncode, _ := json.Marshal(aPrime)
	bEncode, _ := json.Marshal(bPrime)
	logger.L.Info(string(aEncode))
	logger.L.Info(string(bEncode))

	oriText := []byte("helloworld")
	aText := string(bPrime.Apply(aOp.Apply(oriText)))
	bText := string(aPrime.Apply(bOp.Apply(oriText)))

	if string(aText) != string(bText) {
		t.Errorf("aText != bText\naText:%s\nbText:%s\n", string(aText), string(bText))
		return
	}
	logger.L.Info(fmt.Sprintf("transform success:%s", aText))
}

func TestTransform_DeleteAndRetain(t *testing.T) {
	initLogger()
	aOp := Operator{
		Ops: []OperatorAtomic{
			NewRetain(5),
			NewDelete(1),
			NewRetain(4),
		},
		Reversion: 0,
	}
	bOp := Operator{
		Ops: []OperatorAtomic{
			NewRetain(10),
		},
		Reversion: 0,
	}

	aPrime, bPrime, _ := aOp.Transform(&bOp)
	aEncode, _ := json.Marshal(aPrime)
	bEncode, _ := json.Marshal(bPrime)
	logger.L.Info(string(aEncode))
	logger.L.Info(string(bEncode))

	oriText := []byte("helloworld")
	aText := string(bPrime.Apply(aOp.Apply(oriText)))
	bText := string(aPrime.Apply(bOp.Apply(oriText)))

	if string(aText) != string(bText) {
		t.Errorf("aText != bText\naText:%s\nbText:%s\n", string(aText), string(bText))
		return
	}
	logger.L.Info(fmt.Sprintf("transform success:%s", aText))
}
