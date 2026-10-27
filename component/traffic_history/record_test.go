package traffic_history

import (
	C "github.com/metacubex/mihomo/constant"
	"reflect"
	"strings"
	"testing"
	"unsafe"
)

// Every metadata string, including Smart additions, must count against admission
// and own its backing storage. Small substrings must not retain large buffers.
func TestMetadataStringsAreOwnedAndBudgeted(t *testing.T) {
	metadataType := reflect.TypeOf(C.Metadata{})
	for i := 0; i < metadataType.NumField(); i++ {
		field := metadataType.Field(i)
		if field.Type.Kind() != reflect.String {
			continue
		}
		t.Run(field.Name, func(t *testing.T) {
			rec := Record{Metadata: &C.Metadata{}}
			base := rec.size()
			buffer := strings.Repeat("x", 8192)
			borrowed := buffer[100:4196]
			reflect.ValueOf(rec.Metadata).Elem().Field(i).SetString(borrowed)
			if rec.size()-base != int64(len(borrowed)) {
				t.Fatalf("%s is missing from memory accounting", field.Name)
			}
			cloned := rec.clone()
			owned := reflect.ValueOf(cloned.Metadata).Elem().Field(i).String()
			if owned != borrowed || unsafe.StringData(owned) == unsafe.StringData(borrowed) {
				t.Fatalf("%s retained borrowed backing storage", field.Name)
			}
		})
	}
}
