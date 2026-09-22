package protocol

import (
	"encoding/json"
	"fmt"

	"github.com/Bluore/ot-practice/logger"
)

const (
	TypeOperatorRetain TypeOperator = 1 + iota
	TypeOperatorInsert
	TypeOperatorDelete
)

type TypeOperator int

type Operator struct {
	Ops       []OperatorAtomic `json:"ops"`
	Reversion uint32           `json:"reversion"`
}

func (o *Operator) len() int {
	return len(o.Ops)
}

type OperatorAtomic interface {
	isOperator() TypeOperator
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
					N: int(-v),
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

func (o *Operator) MarshalJSON() ([]byte, error) {
	ops := make([]any, 0)
	for _, op := range o.Ops {
		switch v := op.(type) {
		case Insert:
			ops = append(ops, v.Str)
		case Retain:
			ops = append(ops, v.N)
		case Delete:
			ops = append(ops, -v.N)
		}
	}

	var data = map[string]any{
		"ops":       ops,
		"reversion": o.Reversion,
	}
	return json.Marshal(data)
}

type Retain struct {
	N int
}

func NewRetain(n int) Retain {
	return Retain{
		N: n,
	}
}

func (_ Retain) isOperator() TypeOperator {
	return TypeOperatorRetain
}

type Insert struct {
	Str string
}

func NewInsert(str string) Insert {
	return Insert{
		Str: str,
	}
}

func (i Insert) len() int {
	return len(i.Str)
}

func (_ Insert) isOperator() TypeOperator {
	return TypeOperatorInsert
}

type Delete struct {
	N int
}

func NewDelete(n int) Delete {
	return Delete{
		N: n,
	}
}

func (_ Delete) isOperator() TypeOperator {
	return TypeOperatorDelete
}

type operatorIterator struct {
	Operator
	cur OperatorAtomic
	idx int
}

func newOperatorIterator(o *Operator) operatorIterator {
	return operatorIterator{
		Operator: *o,
		cur:      nil,
		idx:      0,
	}
}

func (oi *operatorIterator) next() {
	if oi.idx >= oi.len() {
		return
	}
	oi.cur = nil
	oi.idx++
	return
}

func (oi *operatorIterator) get() (opA OperatorAtomic) {
	if oi.cur != nil {
		return oi.cur
	}
	if oi.idx >= oi.len() {
		return nil
	}
	opA = oi.Ops[oi.idx]
	return
}

func (oi *operatorIterator) getInsert() (op Insert, ok bool) {
	ok = false
	if opA := oi.get(); opA == nil {
		return
	} else {
		op, ok = opA.(Insert)
		return
	}
}
func (oi *operatorIterator) getRetain() (op Retain, ok bool) {
	ok = false
	if opA := oi.get(); opA == nil {
		return
	} else {
		op, ok = opA.(Retain)
		return
	}
}
func (oi *operatorIterator) getDelete() (op Delete, ok bool) {
	ok = false
	if opA := oi.get(); opA == nil {
		return
	} else {
		op, ok = opA.(Delete)
		return
	}
}
func (oi *operatorIterator) refesh(op OperatorAtomic) {
	oi.cur = op
}

func (aOp *Operator) Transform(bOp *Operator) (*Operator, *Operator, error) {
	aIt := newOperatorIterator(aOp)
	bIt := newOperatorIterator(bOp)
	aPrime := &Operator{
		Ops:       make([]OperatorAtomic, 0),
		Reversion: aOp.Reversion,
	}
	bPrime := &Operator{
		Ops:       make([]OperatorAtomic, 0),
		Reversion: bOp.Reversion,
	}

	for {
		if aIt.get() == nil && bIt.get() == nil {
			break
		}

		if b, ok := bIt.getInsert(); ok {
			aPrime.Ops = append(aPrime.Ops, NewRetain(b.len()))
			bPrime.Ops = append(bPrime.Ops, b)
			bIt.next()
			continue
		}

		if a, ok := aIt.getInsert(); ok {
			aPrime.Ops = append(aPrime.Ops, a)
			bPrime.Ops = append(bPrime.Ops, NewRetain(a.len()))
			aIt.next()
			continue
		}

		if a, ok1 := aIt.getDelete(); ok1 {
			if b, ok2 := bIt.getDelete(); ok2 {
				if a.N == b.N {
					aIt.next()
					bIt.next()
				} else if a.N > b.N {
					aIt.refesh(NewDelete(a.N - b.N))
					bIt.next()
				} else {
					aIt.next()
					bIt.refesh(NewDelete(b.N - a.N))
				}
				continue
			}
		}

		if a, ok1 := aIt.getDelete(); ok1 {
			if b, ok2 := bIt.getRetain(); ok2 {
				if a.N == b.N {
					aPrime.Ops = append(aPrime.Ops, a)
					aIt.next()
					bIt.next()
				} else if a.N > b.N {
					aPrime.Ops = append(aPrime.Ops, NewDelete(b.N))
					aIt.refesh(NewDelete(a.N - b.N))
					bIt.next()
				} else {
					aPrime.Ops = append(aPrime.Ops, NewDelete(a.N))
					aIt.next()
					bIt.refesh(NewRetain(b.N - a.N))
				}
				continue
			}
		}

		if a, ok1 := aIt.getRetain(); ok1 {
			if b, ok2 := bIt.getDelete(); ok2 {
				if a.N == b.N {
					bPrime.Ops = append(bPrime.Ops, b)
					aIt.next()
					bIt.next()
				} else if a.N > b.N {
					bPrime.Ops = append(bPrime.Ops, NewDelete(b.N))
					aIt.refesh(NewRetain(a.N - b.N))
					bIt.next()
				} else {
					bPrime.Ops = append(bPrime.Ops, NewDelete(a.N))
					aIt.next()
					bIt.refesh(NewRetain(b.N - a.N))
				}
				continue
			}
		}

		if a, ok1 := aIt.getRetain(); ok1 {
			if b, ok2 := bIt.getRetain(); ok2 {
				if a.N == b.N {
					aPrime.Ops = append(aPrime.Ops, a)
					bPrime.Ops = append(bPrime.Ops, b)
					aIt.next()
					bIt.next()
				} else if a.N > b.N {
					aPrime.Ops = append(aPrime.Ops, NewRetain(b.N))
					bPrime.Ops = append(bPrime.Ops, b)
					aIt.refesh(NewRetain(a.N - b.N))
					bIt.next()
				} else {
					aPrime.Ops = append(aPrime.Ops, a)
					bPrime.Ops = append(bPrime.Ops, NewRetain(a.N))
					aIt.next()
					bIt.refesh(NewRetain(b.N - a.N))
				}
				continue
			}
		}

		if aIt.get() == nil {
			if b, ok := bIt.getRetain(); ok {
				aPrime.Ops = append(aPrime.Ops, b)
				bPrime.Ops = append(bPrime.Ops, b)
				bIt.next()
				continue
			}
		}

		if bIt.get() == nil {
			if a, ok := aIt.getRetain(); ok {
				aPrime.Ops = append(aPrime.Ops, a)
				bPrime.Ops = append(bPrime.Ops, a)
				aIt.next()
				continue
			}
		}

		logger.L.Debug("unsupport operator")
		return nil, nil, fmt.Errorf("unsupport operator")
	}
	return aPrime, bPrime, nil
}

func (oper *Operator) Apply(text []byte) []byte {
	newText := make([]byte, 0)
	idx := 0

	for _, op := range oper.Ops {
		switch v := op.(type) {
		case Insert:
			newText = append(newText, []byte(v.Str)...)
		case Retain:
			if idx+v.N > len(text) {
				break
			}
			newText = append(newText, text[idx:idx+v.N]...)
			idx += v.N
		case Delete:
			idx += v.N
		}
	}
	return newText
}
