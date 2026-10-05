


export function ComplexCompare(a:string,b:string){

    let done = false;

    let apos = 0;
    let bpos = 0;
    let amax = a.length
    let bmax = b.length

    let anum = "";
    let bnum = "";

    let numbers = ["0","1","2","3","4","5","6","7","8","9"]

    let comp = 0;
    
    while(!done){
        if(apos<amax &&bpos<bmax){
            anum = "";
            bnum = "";
            while(numbers.includes(a[apos]) && apos < amax){
                anum += a[apos]
                apos++;
            }

            while(numbers.includes(b[bpos]) && bpos < bmax){
                bnum += b[bpos]
                bpos++;
            }

            if(anum != "" && bnum != ""){
                comp = Number(anum) - Number(bnum);
                if(comp != 0){
                    return comp;
                }
            }else{
                if(anum != ""){
                    return 1
                }else if(bnum != ""){
                    return -1;
                }else{
                    comp = a[apos].localeCompare(b[bpos],undefined, { sensitivity: 'accent' });
                    if(comp != 0){
                        return comp;
                    }else{
                        apos++;
                        bpos++;
                    }
                }
            }



        }else{
            done = true;
        }
    }
    return 0;
    
}


// Transport URNs used by NMOS resources, mapped to the short codes used internally
// (see CrosspointConnectionSenderInfo.transport). USB is TCP based, not RTP. The MatroxOnly
// spec names it urn:x-matrox:transport:usb; IPMX nodes (e.g. alabou/NMOS-Reference) publish
// urn:x-nmos:transport:usb as the canonical form and accept both, so both must map to "usb".
const transportShortCodes: {[urn:string]: "rtp" | "rtp.mcast" | "usb"} = {
    "urn:x-nmos:transport:rtp": "rtp",
    "urn:x-nmos:transport:rtp.mcast": "rtp.mcast",
    "urn:x-matrox:transport:usb": "usb",
    "urn:x-nmos:transport:usb": "usb",
}

export function transportShortCode(urn:string): "rtp" | "rtp.mcast" | "usb" | ""{
    if(typeof urn != "string"){ return ""; }
    return transportShortCodes[urn] ?? "";
}

export function isUsbTransport(urn:string){
    return transportShortCode(urn) == "usb";
}

/**
 * Does this transport carry a multicast destination address at all?
 *
 * Only the RTP transports do. MXL is shared memory, websocket and MQTT are
 * point-to-point over TCP, and the Matrox USB transport is a direct link —
 * none of them has a destination_ip, so multicast addressing is meaningless
 * for them and they must never be given an address from a pool. Unicast RTP
 * (rtp.ucast) is excluded too: its destination_ip is a host, not a group.
 */
export function isMulticastTransport(urn:string){
    return urn === "urn:x-nmos:transport:rtp" || urn === "urn:x-nmos:transport:rtp.mcast";
}

// Crosspoint sender/receiver flow ids are always "nmos_" + the NMOS resource id, so the bare
// id can be recovered by stripping the prefix.
//
// Crosspoint *device* ids cannot: legacy entries in state/crosspoint.json use
// "nmosgrp_" + md5(grouphint + device_id), which is not reversible. Resolve a device via one of
// its flows instead (see nmosDeviceIdFromFlowId) rather than parsing a device id.
export function nmosIdFromCrosspointId(id:string){
    if(typeof id != "string"){ return ""; }
    if(id.startsWith("nmos_")){ return id.slice(5); }
    return id;
}

export function ShortenNames(dev:string,flow:string){
    let name = "";
    let sync = true;
    for(let i = 0; i< flow.length; i++){
        if(i<dev.length && sync){
            if(dev[i] == flow[i]){
                // Same beginning
            }else{
                sync = false;
                name += flow[i]
            }
        }else{
            name += flow[i]
        }
    }
    return name;
}
