package protocol

type ClientMessage struct {
	Edit *EditMsg `json:"edit,omitempty"`
}

type ClientInitMessage struct {
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
}

type EditMsg struct {
	Reversion uint32   `json:"reversion"`
	Operator  Operator `json:"operator"`
}

type ServerMessage struct {
}
