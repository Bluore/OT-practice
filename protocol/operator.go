package protocol

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/Bluore/ot-practice/logger"
)

type Operator struct {
	Ops []OperatorAtomic `json:"ops"`
}

type OperatorAtomic interface {
	isOperator()
}

func (o *Operator) UnmarshalJSON(data []byte) error {
	var raw []any

	err := json.Unmarshal(data, &raw)
	if err != nil {
		logger.L.Error("unmarshal operator_atomic fail")
		return err
	}

	ops := make([]OperatorAtomic, 0)

	for _, item := range raw {
		var op OperatorAtomic
		switch v := item.(type) {
		case string:
			op = Insert{
				Str: v,
			}
		case float64:
			if v >= 0 {
				op = Retain{
					N: int(v),
				}
			} else {
				op = Delete{
					N: int(v),
				}
			}
		default:
			return fmt.Errorf("unmarshal operator_atomic fail: %v", v)
		}

		ops = append(ops, op)
	}
	o.Ops = ops

	return nil
}

type Retain struct {
	N int
}

func (_ Retain) isOperator() {}

func (r Retain) MarshalJSON() (data []byte, err error) {
	return []byte(strconv.Itoa(r.N)), nil
}

type Insert struct {
	Str string
}

func (_ Insert) isOperator() {}

func (i Insert) MarshalJSON() (data []byte, err error) {
	return []byte(i.Str), nil
}

type Delete struct {
	N int
}

func (_ Delete) isOperator() {}

func (d Delete) MarshalJSON() (data []byte, err error) {
	return []byte(strconv.Itoa(d.N)), nil
}
