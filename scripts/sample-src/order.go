package main

import (
	"errors"
	"regexp"
	"strings"
)

// Order entity. The validation messages below are the exact copy the system
// under test renders, so generated cases can anchor assertions on them.
type Order struct {
	ID           int64       `json:"id"`
	OrderNo      string      `json:"orderNo"`
	ReceiverName string      `json:"receiverName"`
	Phone        string      `json:"phone"`
	Address      string      `json:"address"`
	Amount       string      `json:"amount"`
	Remark       string      `json:"remark"`
	Status       OrderStatus `json:"status"`
}

// phonePattern is the mobile number format the create form enforces.
var phonePattern = regexp.MustCompile(`^1[3-9]\d{9}$`)

// Validate enforces the field constraints. Each returned message is the
// exact copy the system under test renders for that validation failure.
func (o *Order) Validate() error {
	if strings.TrimSpace(o.ReceiverName) == "" {
		return errors.New("Receiver name cannot be empty")
	}
	if len(o.ReceiverName) > 20 {
		return errors.New("Receiver name cannot exceed 20 characters")
	}
	if strings.TrimSpace(o.Phone) == "" {
		return errors.New("Phone number cannot be empty")
	}
	if !phonePattern.MatchString(o.Phone) {
		return errors.New("Phone number format is invalid")
	}
	if strings.TrimSpace(o.Address) == "" {
		return errors.New("Address cannot be empty")
	}
	if len(o.Address) > 100 {
		return errors.New("Address cannot exceed 100 characters")
	}
	if strings.TrimSpace(o.Amount) == "" {
		return errors.New("Amount cannot be empty")
	}
	if len(o.Remark) > 200 {
		return errors.New("Remark cannot exceed 200 characters")
	}
	return nil
}
