package protocol

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestTransform_InsertAndInsert(t *testing.T) {
	aOp := Operator{
		Ops: []OperatorAtomic{
			NewInsert("hello"),
			NewDelete(3),
		},
		Reversion: 0,
	}
	bOp := Operator{
		Ops: []OperatorAtomic{
			NewInsert("world"),
			NewRetain(3),
		},
		Reversion: 0,
	}

	aPrime, bPrime, _ := aOp.Transform(&bOp)
	aEncode, err := json.Marshal(aPrime)
	_ = err
	bEncode, _ := json.Marshal(bPrime)
	fmt.Println(string(aEncode))
	fmt.Println(string(bEncode))
}
