export function parseSettings(settings:any){


    if(!settings.hasOwnProperty("reconnectOnSdpChanges")){
        settings.reconnectOnSdpChanges = false;
    }else{
        if(typeof settings.reconnectOnSdpChanges != "boolean"){
            settings.reconnectOnSdpChanges = false;
        }
    }


    if(!settings.hasOwnProperty("fixSdpBugs")){
        settings.fixSdpBugs = false;
    }else{
        if(typeof settings.fixSdpBugs != "boolean"){
            settings.fixSdpBugs = false;
        }
    }


    if(!settings.hasOwnProperty("autoMulticast")){
        settings.autoMulticast = false;
    }else{
        if(typeof settings.autoMulticast != "boolean"){
            settings.autoMulticast = false;
        }
    }


    if(!settings.hasOwnProperty("firstDynamicNumber")){
        settings.firstDynamicNumber = 1000;
    }else{
        if(typeof settings.firstDynamicNumber != "number"){
            settings.firstDynamicNumber = 1000;
        }else{
            settings.firstDynamicNumber = Number.parseInt(settings.firstDynamicNumber);
        }

        if(settings.firstDynamicNumber < 1){
            settings.firstDynamicNumber = 1000;
        }
    }


    // Predictive staging configuration
    if(!settings.hasOwnProperty("predictiveStaging")){
        settings.predictiveStaging = { enabled: false, cooldownMs: 10000, perReceiver: {} };
    }else{
        const ps = settings.predictiveStaging;
        if(typeof ps !== 'object' || ps === null){
            settings.predictiveStaging = { enabled: false, cooldownMs: 10000, perReceiver: {} };
        }else{
            if(!ps.hasOwnProperty('enabled') || typeof ps.enabled !== 'boolean'){
                ps.enabled = false;
            }
            if(!ps.hasOwnProperty('cooldownMs')){
                ps.cooldownMs = 10000;
            }else{
                if(typeof ps.cooldownMs !== 'number'){
                    ps.cooldownMs = 10000;
                }else{
                    ps.cooldownMs = Number.parseInt(ps.cooldownMs);
                    if(ps.cooldownMs < 0){ ps.cooldownMs = 10000; }
                }
            }
            if(!ps.hasOwnProperty('perReceiver') || typeof ps.perReceiver !== 'object'){
                ps.perReceiver = {};
            }
        }
    }

    // Debug logs toggle (controls debug/verbose output through SyncLog)
    if(!settings.hasOwnProperty("debugLogs")){
        settings.debugLogs = false;
    }else{
        if(typeof settings.debugLogs !== "boolean"){
            settings.debugLogs = false;
        }
    }

    return settings;
}