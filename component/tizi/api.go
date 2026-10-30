// Package tizi implements the optional managed group subscription service.
package tizi

import (
	"encoding/json"
	"flag"
	"io"
	"os"
)

type commandResult struct {
	OK    bool          `json:"ok"`
	Data  any           `json:"data,omitempty"`
	Error *commandError `json:"error,omitempty"`
}
type commandError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Main never prints credential material or decrypted configuration.
func Main(args []string) {
	fs := flag.NewFlagSet("tizi", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	dir := fs.String("state-dir", "", "private state directory")
	var result commandResult
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		result.Error = &commandError{"invalid_request", "Expected tizi --state-dir PATH COMMAND"}
	} else {
		var input map[string]any
		dec := json.NewDecoder(io.LimitReader(os.Stdin, 65537))
		err := dec.Decode(&input)
		if err != nil && err != io.EOF {
			result.Error = &commandError{"invalid_request", "Invalid JSON request"}
		} else {
			data, err := runCommand(*dir, fs.Arg(0), input)
			if err != nil {
				result.Error = &commandError{"tizi_error", err.Error()}
			} else {
				result.OK = true
				result.Data = data
			}
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
}
