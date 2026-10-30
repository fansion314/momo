//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework SystemConfiguration -framework CoreFoundation
#include <sys/socket.h>
#include <sys/types.h>
#include <libproc.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdbool.h>
#include <SystemConfiguration/SystemConfiguration.h>
static int clear_proxy_fields(const char *service_name, int kind) {
 SCPreferencesRef prefs=SCPreferencesCreate(NULL,CFSTR("world.fansionia.clash-momo.helper"),NULL);
 if(!prefs) return -1;
 int result=-1;
 if(!SCPreferencesLock(prefs,true)){CFRelease(prefs);return -1;}
 CFArrayRef services=SCNetworkServiceCopyAll(prefs);
 CFStringRef name=CFStringCreateWithCString(NULL,service_name,kCFStringEncodingUTF8);
 if(services&&name) {
  for(CFIndex i=0;i<CFArrayGetCount(services);i++) {
   SCNetworkServiceRef service=(SCNetworkServiceRef)CFArrayGetValueAtIndex(services,i);
   CFStringRef currentName=SCNetworkServiceGetName(service);
   if(!currentName||!CFEqual(currentName,name)) continue;
   SCNetworkProtocolRef proxies=SCNetworkServiceCopyProtocol(service,kSCNetworkProtocolTypeProxies);
   if(!proxies) break;
   CFDictionaryRef current=SCNetworkProtocolGetConfiguration(proxies);
   CFMutableDictionaryRef config=current?CFDictionaryCreateMutableCopy(NULL,0,current):CFDictionaryCreateMutable(NULL,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
   if(config) {
    // Remove only fixed address fields; preserve enabled flags and unrelated settings.
    switch(kind) {
     case 0: CFDictionaryRemoveValue(config,kSCPropNetProxiesProxyAutoConfigURLString); break;
     case 1: CFDictionaryRemoveValue(config,kSCPropNetProxiesHTTPProxy); CFDictionaryRemoveValue(config,kSCPropNetProxiesHTTPPort); break;
     case 2: CFDictionaryRemoveValue(config,kSCPropNetProxiesHTTPSProxy); CFDictionaryRemoveValue(config,kSCPropNetProxiesHTTPSPort); break;
     case 3: CFDictionaryRemoveValue(config,kSCPropNetProxiesSOCKSProxy); CFDictionaryRemoveValue(config,kSCPropNetProxiesSOCKSPort); break;
     default: CFRelease(config); CFRelease(proxies); goto cleanup;
    }
    if(SCNetworkProtocolSetConfiguration(proxies,config)&&SCPreferencesCommitChanges(prefs)&&SCPreferencesApplyChanges(prefs)) result=0;
    CFRelease(config);
   }
   CFRelease(proxies);
   break;
  }
 }
 cleanup:
 if(name) CFRelease(name);
 if(services) CFRelease(services);
 SCPreferencesUnlock(prefs);
 CFRelease(prefs);
 return result;
}
static int peer_uid(int fd) { uid_t uid; gid_t gid; if(getpeereid(fd,&uid,&gid)) return -1; return (int)uid; }
static int process_identity(int pid, char *out, int length) {
 struct proc_bsdinfo info;
 char path[PROC_PIDPATHINFO_MAXSIZE];
 if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=sizeof(info)) return -1;
 if(proc_pidpath(pid,path,sizeof(path))<=0) return -1;
 return snprintf(out,length,"%llu:%llu:%s",info.pbi_start_tvsec,info.pbi_start_tvusec,path);
}
*/
import "C"

import (
	"errors"
	"net"
	"unsafe"
)

func clearPACURL(service string) error {
	name := C.CString(service)
	defer C.free(unsafe.Pointer(name))
	if C.clear_proxy_fields(name, 0) != 0 {
		return errors.New("cannot clear saved empty PAC URL with SystemConfiguration")
	}
	return nil
}

func clearProxyAddress(service, kind string) error {
	kinds := map[string]int{"webproxy": 1, "securewebproxy": 2, "socksfirewallproxy": 3}
	value, ok := kinds[kind]
	if !ok {
		return errors.New("unsupported proxy address kind")
	}
	name := C.CString(service)
	defer C.free(unsafe.Pointer(name))
	if C.clear_proxy_fields(name, C.int(value)) != 0 {
		return errors.New("cannot clear saved empty proxy address with SystemConfiguration")
	}
	return nil
}

func peerUID(conn *net.UnixConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	uid := -1
	if err = raw.Control(func(fd uintptr) { uid = int(C.peer_uid(C.int(fd))) }); err != nil {
		return 0, err
	}
	if uid < 0 {
		return 0, errors.New("cannot determine socket peer UID")
	}
	return uid, nil
}

func processIdentity(pid int) (string, error) {
	buf := make([]byte, 8192)
	n := int(C.process_identity(C.int(pid), (*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf))))
	if n < 0 || n >= len(buf) {
		return "", errors.New("cannot determine process identity")
	}
	return string(buf[:n]), nil
}
