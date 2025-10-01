<script lang="ts">
    import ServerConnector from "../../lib/ServerConnector/ServerConnectorService";
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";

    import { Icon, MagnifyingGlass, EllipsisVertical, RectangleGroup,ArrowPath, Cog, Pencil, ChevronRight, VideoCamera, Microphone, CodeBracketSquare, 
      BarsArrowDown,
      BarsArrowUp, 
      ArrowUturnLeft,
      CodeBracket
    } from "svelte-hero-icons";
    import SetupFlow from "../../lib/SetupFlow.svelte";
    import SetupDevice from "../../lib/SetupDevice.svelte";
    import OverlayMenuService from "../../lib/OverlayMenu/OverlayMenuService";
    import ScrollArea from "../../lib/ScrollArea.svelte";
    import { getSearchTokens, tokenSearch } from "../../lib/functions";


    let tableCols = [

        {id:"state", name:"", sortable:true,sortField:"__customState",  resize:false , canHide:false, fixed:true},
        {id:"name", name:"Name" ,     sortable:true,sortField:"name",  resize:true  , canHide:false, fixed:true, fixedOffset:40},
        {id:"alias", name:"Alias" ,     sortable:true,sortField:"alias",  resize:true  , canHide:true},

        {id:"sn", name:"# SN" ,          sortable:true,sortField:"sn",  resize:false , canHide:true},
        {id:"fwversion", name:"Firmware" ,     sortable:true,sortField:"firmwareVersion",  resize:false  , canHide:true},
        {id:"fwmode", name:"Mode" ,     sortable:true,sortField:"simpleMode",  resize:false  , canHide:true},
        {id:"type", name:"Type" ,     sortable:true,sortField:"type",  resize:false  , canHide:true},
        {id:"ip", name:"IP Address" ,     sortable:true, sortField:"__customIpList", resize:true  , canHide:false},
        {id:"bitrate", name:"Bitrate" ,     sortable:true, sortField:"__customBitrate", resize:false  , canHide:true},
        
        {id:"network", name:"Network" ,     sortable:true, sortField:"__customNetwork", resize:true  , canHide:true},
        
        {id:"temperature", name:"Temperature" ,     sortable:false, resize:false  , canHide:true},
        
        {id:"frontpanelLock", name:"Buttons Locked" ,     sortable:false, resize:false  , canHide:true},
        {id:"hdcpEnabled", name:"HDCP Enabled" ,     sortable:false, resize:false  , canHide:true},
        {id:"jpegxsLicensed", name:"JPEG XS License" ,     sortable:false, resize:false  , canHide:true},

        {id:"ptpStatus", name:"PTP Status" ,     sortable:true, sortField:"ptpStatus", resize:false  , canHide:true},
        {id:"ptpDomain", name:"PTP Domain" ,     sortable:true, sortField:"__customPtpDomain", resize:false  , canHide:true},
        {id:"ptpMenu", name:"" ,     sortable:false,  resize:false  , canHide:true},
        {id:"igmpVersion", name:"IGMP Version" ,     sortable:true, sortField:"igmpVersion", resize:false  , canHide:true},
        {id:"igmpMenu", name:"" ,     sortable:false,  resize:false  , canHide:true},
        {id:"audioStreamEnabled", name:"Audio Stream" ,     sortable:true, sortField:"audioStreamEnabled", resize:false  , canHide:true},
        {id:"audioMenu", name:"" ,     sortable:false,  resize:false  , canHide:true},
        {id:"restartMenu", name:"" ,     sortable:false,  resize:false  , canHide:true},
        {id:"flowMode", name:"Flow Mode" ,     sortable:true, sortField:"flowMode", resize:false  , canHide:true},

        
        {id:"masterEnabled", name:"Master Enable" ,     sortable:true, sortField:"masterEnabled",  resize:false  , canHide:true},
        {id:"masterEnabledMenu", name:"" ,     sortable:false,  resize:false  , canHide:false},


        {id:"inputResolution", name:"Input" ,     sortable:false,  resize:false  , canHide:true},
        {id:"scalerMode", name:"Scaler" ,     sortable:false,  resize:false  , canHide:true},
        {id:"outputResolution", name:"Output" ,     sortable:false,  resize:false  , canHide:true},
        {id:"scalerModeMenu", name:"" ,     sortable:false,  resize:false  , canHide:true},
        
        {id:"audioFormat", name:"Audio Format" ,     sortable:false,  resize:false  , canHide:true},
        
        {id:"edidMonitor", name:"Monitor EDID" ,     sortable:false,  resize:false  , canHide:true},
        {id:"edidNativeResMonitor", name:"Monitor Native Resolution" ,     sortable:false,  resize:true  , canHide:true},

        {id:"edidInput", name:"Input EDID" ,     sortable:false,  resize:false  , canHide:true},
        {id:"edidNativeResInput", name:"Input Native Resolution" ,     sortable:false,  resize:false  , canHide:true},
        {id:"edidModeMenu", name:"" ,     sortable:false,  resize:false  , canHide:true},
    ]

    

    

    let filter:any = {
      version:"112371",
      // Hide most columns by default, keep: Name, Mode, Type, IP Address, Master Enable, Input, Output
      hiddenCols:[
        "sn",
        "fwversion","network","bitrate","temperature","frontpanelLock","hdcpEnabled","jpegxsLicensed",
        "ptpStatus","ptpDomain","ptpMenu","igmpVersion","igmpMenu","audioStreamEnabled","audioMenu","restartMenu","flowMode",
        "scalerMode","scalerModeMenu","audioFormat",
        "edidMonitor","edidNativeResMonitor","edidInput","edidNativeResInput","edidModeMenu"
      ],
      widthCols:{},
      sort:{ id: "", dir: "down" },
      search:"",
      batchJob:"",
      batchJobReboot:false,
      nmosRegistryIp:"",
      nmosRegistryPort:80,
    };


    

    let sourceState:any = {devices:{},settings:{edids:[],resolutions:[],ptpDomain:127},quickState:{
        label:"Matrox Convert IP",
        name:"matroxcip",
        count:0,
        error:0,
        detail: [
            {label:"Connected", color: "success", count:0 },
            {label:"Session Conflict", color: "warning", count:0 },
            {label:"Unreachable", color: "error", count:0 },
        ],
        note:""
    }};
    let list:any = [];

    let menu = OverlayMenuService;

    let sync:Subject<any> ;
    
    // Reactive variable for auto-reauth toggle state
    $: isAutoReauthEnabled = !sourceState.settings?.disableAutoReauth;


    onMount(async () => {
        sync = ServerConnector.sync("mediadevmatroxcip")
        sync.subscribe((obj:any)=>{
            sourceState = obj;
             doFilter();
        });
      try{
        let f = localStorage.getItem("mediadevmatroxcip_filter");
        if(f){
          let tempFilter = JSON.parse(f);
          if(tempFilter.version == filter.version){
            filter = tempFilter;
          }else{
            console.log("Resetting mediadevmatroxcip filter localstorage.");
            saveFilter();
          }
        }
      }catch(e){}
    });
    onDestroy(() => {
      sync.unsubscribe();
          ServerConnector.unsync("mediadevmatroxcip")
    });

      function saveFilter(){
      localStorage.setItem("mediadevmatroxcip_filter", JSON.stringify(filter));
    }

    function doFilter(){
        // Filtering + sorting
        list = [];
        for(let cip in sourceState.devices){
            list.push(structuredClone(sourceState.devices[cip]))
        }
        if(filter.search != ""){
          let searchTokens = getSearchTokens(filter.search);
          list = list.filter((cip:any)=>{
            return (
              tokenSearch(cip, searchTokens, ["name","sn"]) ||
              tokenSearch((cip.ipList || []).join(" "), searchTokens)
            );
          });
        }

        list.sort((a:any, b:any) => {
          const sortId = (filter.sort && filter.sort.id) ? filter.sort.id : "";
          if (!sortId) { return 0; }
          let sortField: string | undefined = undefined;
          tableCols.forEach((c) => { if (c.id === sortId) { sortField = c.sortField; } });
          if (!sortField) { return 0; }
          const dirMul = (filter.sort.dir === "down") ? 1 : -1;
          if (sortField === "__customState") {
            const at = !!(a.failed || a.sessionConflict);
            const bt = !!(b.failed || b.sessionConflict);
            if (at === bt) return 0;
            return (at ? 1 : -1) * dirMul;
          } else if (sortField === "__customPtpDomain") {
            const av = (a.ptpDomain ?? 0);
            const bv = (b.ptpDomain ?? 0);
            if (av === bv) return 0;
            return (av < bv ? 1 : -1) * dirMul;
          } else if (sortField === "__customNetwork") {
            let ac = 0; let bc = 0;
            (a.linkStatus || []).forEach((l:any)=>{ if(l.up){ ac++; } });
            (b.linkStatus || []).forEach((l:any)=>{ if(l.up){ bc++; } });
            if (ac === bc) return 0;
            return (ac < bc ? 1 : -1) * dirMul;
          } else if (sortField === "__customIpList") {
            const a0 = ((a.ipList && a.ipList[0]) || "");
            const b0 = ((b.ipList && b.ipList[0]) || "");
            const comp = a0.localeCompare(b0, undefined, { sensitivity: 'accent' });
            return comp * dirMul;
          } else if (sortField === "__customBitrate") {
            const aBitrate = (a.inputBitrate || 0) + (a.outputBitrate || 0);
            const bBitrate = (b.inputBitrate || 0) + (b.outputBitrate || 0);
            if (aBitrate === bBitrate) return 0;
            return (aBitrate < bBitrate ? 1 : -1) * dirMul;
          } else {
            const av:any = a[sortField];
            const bv:any = b[sortField];
            if (typeof av === "string" || typeof bv === "string") {
              const as = (av ?? "").toString();
              const bs = (bv ?? "").toString();
              const comp = as.localeCompare(bs, undefined, { sensitivity: 'accent' });
              return comp * dirMul;
            } else {
              const an = Number(av ?? 0);
              const bn = Number(bv ?? 0);
              if (an === bn) return 0;
              return (an < bn ? 1 : -1) * dirMul;
            }
          }
        });

        // TODO Bug with Sort Cols not icon color updating on multiple changes
    }



    function batchJob(sn:string){
      ServerConnector.startLoad();
        ServerConnector.post("matroxcip_batchjob",{sn:sn, context:filter.batchJob, reboot:filter.batchJobReboot}).then((f:any)=>{
        ServerConnector.endLoad();
        ServerConnector.addFeedback({level:"success",message:"Command done"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Command Failed: "+ e.message})
        });
    }


   
     function forceReload(sn:string){
        ServerConnector.get("matroxcip_forcereload/"+sn).then((f:any)=>{
        }).catch((e)=>{
        });
     }
     function forceReloadAll(){
        ServerConnector.get("matroxcip_forcereloadall").then((f:any)=>{
        }).catch((e)=>{
        });
     }

     function ptpEnableAll(){
        ServerConnector.startLoad();
        ServerConnector.get("matroxcip_ptpenableall").then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:"PTP enabled on all devices"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Failed to enable PTP on all devices: "+ e.message})
        });
     }

     function ptpDisableAll(){
        ServerConnector.startLoad();
        ServerConnector.get("matroxcip_ptpdisableall").then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:"PTP disabled on all devices"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Failed to disable PTP on all devices: "+ e.message})
        });
     }

     function restartDevice(sn:string){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_restart",{sn:sn}).then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:"Device restart initiated"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Failed to restart device: "+ e.message})
        });
     }

     function restartAll(){
        ServerConnector.startLoad();
        ServerConnector.get("matroxcip_restartall").then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:"All devices restart initiated"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Failed to restart all devices: "+ e.message})
        });
     }

    function fixPtpDomain(sn:string){
      ServerConnector.startLoad();
        ServerConnector.post("matroxcip_fixptpdomain",{sn:sn}).then((f:any)=>{
        ServerConnector.endLoad();
        ServerConnector.addFeedback({level:"success",message:"PTP changed"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Can not change PTP: "+ e.message})
        });
    }

    function setManualNmosRegistry() {
        if (!filter.nmosRegistryIp || !filter.nmosRegistryPort) {
            ServerConnector.addFeedback({level:"error",message:"Please enter both IP address and port"});
            return;
        }

        // Get all devices from the state
        const allDevices = Object.keys(sourceState.devices || {});
        if (allDevices.length === 0) {
            ServerConnector.addFeedback({level:"error",message:"No Matrox devices found"});
            return;
        }

        // Validate IP format
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        if (!ipRegex.test(filter.nmosRegistryIp)) {
            ServerConnector.addFeedback({level:"error",message:"Please enter a valid IP address"});
            return;
        }

        // Validate port range
        const port = parseInt(filter.nmosRegistryPort);
        if (port < 1 || port > 65535) {
            ServerConnector.addFeedback({level:"error",message:"Please enter a valid port number (1-65535)"});
            return;
        }

        ServerConnector.startLoad();

        // Configure NMOS registry for all devices
        let configuredCount = 0;
        let errorCount = 0;
        
        allDevices.forEach((sn: string) => {
            ServerConnector.post("matroxcip_setnmosregistry", {
                sn: sn,
                ip: filter.nmosRegistryIp,
                port: port
            }).then((f:any) => {
                configuredCount++;
                if (configuredCount + errorCount === allDevices.length) {
                    ServerConnector.endLoad();
                    if (errorCount === 0) {
                        ServerConnector.addFeedback({level:"success",message:`NMOS registry configured successfully on all ${configuredCount} device(s)`});
                        saveFilter();
                        nmosRegistryModal.close();
                    } else {
                        ServerConnector.addFeedback({level:"warning",message:`NMOS registry configured on ${configuredCount} of ${allDevices.length} devices (${errorCount} failed)`});
                    }
                }
            }).catch((e) => {
                errorCount++;
                if (configuredCount + errorCount === allDevices.length) {
                    ServerConnector.endLoad();
                    ServerConnector.addFeedback({level:"error",message:`Failed to configure NMOS registry on ${errorCount} device(s): ${e.message}`});
                }
            });
        });
    }

     function changeEdid(sn:string, name:string){
      ServerConnector.startLoad();
        ServerConnector.post("matroxcip_changeedid",{sn:sn, name:name}).then((f:any)=>{
        ServerConnector.endLoad();
        ServerConnector.addFeedback({level:"success",message:"EDID changed"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Can not change EDID: "+ e.message})
        });
     }

     function enableMaster(sn:string){
      ServerConnector.startLoad();
      ServerConnector.post("matroxcip_enablemaster",{sn:sn}).then((f:any)=>{
        ServerConnector.endLoad();
        ServerConnector.addFeedback({level:"success",message:"Master enabled"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Can not enable master: "+ e.message})
        });
     }

     function togglePtp(sn:string, enabled:boolean){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_toggleptp",{sn:sn, enabled:enabled}).then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:enabled ? "PTP enabled" : "PTP disabled"});
        }).catch((e:any)=>{
            ServerConnector.endLoad();
            ServerConnector.addFeedback({level:"error",message:"Failed to toggle PTP: " + e.message});
        });
     }

     function toggleAudioStream(sn:string, streamType: 'tx' | 'rx', streamIndex: number, enabled:boolean){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_toggleaudio",{
            sn:sn, 
            streamType:streamType, 
            streamIndex:streamIndex, 
            enabled:enabled
        }).then((f:any)=>{
          ServerConnector.endLoad();
          const streamName = `${streamType.toUpperCase()} Audio Stream ${streamIndex}`;
          ServerConnector.addFeedback({level:"success",message:`${streamName} ${enabled ? "enabled" : "disabled"}`});
        }).catch((e:any)=>{
            ServerConnector.endLoad();
            ServerConnector.addFeedback({level:"error",message:"Failed to toggle audio stream: " + e.message});
        });
     }

     function getAudioStreamState(dev: any): { type: 'tx' | 'rx', enabled: boolean, label: string } {
        // Return the active stream type and enabled state
        if (dev.txAudioStream0Enabled) {
            return { type: 'tx', enabled: true, label: 'TX Audio 0' };
        } else if (dev.rxAudioStream0Enabled) {
            return { type: 'rx', enabled: true, label: 'RX Audio 0' };
        } else {
            // Default to TX when neither is enabled (most common case for encoders)
            return { type: 'tx', enabled: false, label: 'Audio Stream' };
        }
     }

     function toggleAutoReauth(enabled:boolean){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_toggleautoreauth",{enabled:enabled}).then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:enabled ? "Auto-reauthentication enabled" : "Auto-reauthentication disabled"});
        }).catch((e:any)=>{
            ServerConnector.endLoad();
            ServerConnector.addFeedback({level:"error",message:"Failed to toggle auto-reauthentication: " + e.message});
        });
     }

      function setIgmpVersion(sn:string, version:string){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_setigmp",{sn:sn, version:version}).then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:`IGMP version set to ${version.toUpperCase()}`})
          ServerConnector.addFeedback({level:"warning",message:"Device reboot required for IGMP changes to take effect"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Can not set IGMP version: "+ e.message})
        });
      }

      function setIgmpVersionAll(version:string){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_setigmpall",{version:version}).then((f:any)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"success",message:`IGMP version set to ${version.toUpperCase()} on all devices`})
          ServerConnector.addFeedback({level:"warning",message:"Device reboot required for IGMP changes to take effect on all devices"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Can not set IGMP version on all devices: "+ e.message})
        });
      }

     function changeResolution(sn:string, name:string){
        ServerConnector.startLoad();
        ServerConnector.post("matroxcip_changeresolution",{sn:sn, name:name}).then((f:any)=>{
        ServerConnector.endLoad();
        ServerConnector.addFeedback({level:"success",message:"Resolution changed"})
        }).catch((e)=>{
          ServerConnector.endLoad();
          ServerConnector.addFeedback({level:"error",message:"Can not change resolution: "+ e.message})
        });
      }

      function formatRxScalerMode(dev:any): string {
        const mode = (dev.monitorMode || dev.moinitorMode || "").toString();
        switch (mode) {
          case "force": return "Force";
          case "stream": return "Auto";
          case "edidpreference": return "Scale to EDID";
          default: return mode;
        }
      }

      
      function getMenuTxScalerMode(dev:any){
        let data:any = {entry:[]}
        for(let res of sourceState.settings.resolutions){
          data.entry.push({label:"Force Resolution: "+res.name,callback:()=>{changeResolution(dev.sn,res.name)}})
      }
      data.entry.push({label:"No Scaling",callback:()=>{changeResolution(dev.sn,"__input")}})
      return data
     }
     function getMenuRxScalerMode(dev:any){
        let data:any = {entry:[]}
        for(let res of sourceState.settings.resolutions){
          data.entry.push({label:"Force Resolution: "+res.name,callback:()=>{changeResolution(dev.sn,res.name)}})
      }
      data.entry.push({label:"Scale to EDID",callback:()=>{changeResolution(dev.sn,"__edid")}})
      data.entry.push({label:"Auto",callback:()=>{changeResolution(dev.sn,"__input")}})
      return data
     }
      
     function getMenuInputEdid(dev:any){
        let data:any = {entry:[]}
        for(let res of sourceState.settings.edids){
          data.entry.push({label:"Use EDID: "+res.name,callback:()=>{changeEdid(dev.sn,res.name)}})
      }
      data.entry.push({label:"Use Native EDID",callback:()=>{changeEdid(dev.sn,"__nativeMatrox")}})
      data.entry.push({label:"Passthrough EDID",callback:()=>{changeEdid(dev.sn,"__passthrough")}})
      return data
     }

      

     let tableModal:any;
     let batchModal:any;
     let nmosRegistryModal:any;

      let batchActive = false;

      let editorModal;
      let activeEditorId:string = "";
      let activeEditorType:string = "";
      
      let filterTimeout:any = null;
      function changeFilter(immediate=false){
        if(immediate){
          if(filterTimeout){
            clearTimeout(filterTimeout);
          }
          doFilter();
          saveFilter();
          return;
        }
        if(filterTimeout){
          clearTimeout(filterTimeout);
          filterTimeout = null;
        }
        filterTimeout = setTimeout(()=>{
          doFilter();
          saveFilter();
        },200);
      }

      function toggleHiddenCol(id:string = ""){
        if(id == ""){
          filter.hiddenCols = [];
          // trigger reactivity and persist
          filter = { ...filter };
          saveFilter();
          return;
        }
        if(filter.hiddenCols.includes(id)){
          filter.hiddenCols = filter.hiddenCols.filter((c: string)=>{
            if(c == id){
              return false
            }
            return true
          })
        }else{
          filter.hiddenCols.push(id);
        }
        filter = {...filter}
        saveFilter()
      }

      let resizeDragPos = 0;
      let resizeDragStartWidth = 0;
      
      function startResizeDrag(e:MouseEvent, id:string){
        resizeDragPos = e.x;

        if(!filter.widthCols.hasOwnProperty(id)){
          filter.widthCols[id] = 0
        }
        resizeDragStartWidth = filter.widthCols[id];
      }

      function updateResizeDrag(e:MouseEvent, id:string){
        if(e.x != 0){
          filter.widthCols[id] = (e.x - resizeDragPos) + resizeDragStartWidth
        }
          

      }

      function endResizeDrag(e:MouseEvent, id:string){
        saveFilter();
        
      }


      function toggleSort(id:string){
        if(!filter.sort || filter.sort.id !== id){
          filter.sort = { id, dir: "down" };
        }else{
          filter.sort = { id, dir: (filter.sort.dir === "down" ? "up" : "down") };
        }
        doFilter();
        saveFilter();
      }
  </script>
  


  <div class="content-container">

    

    <ul class="menu bg-base-200 menu-horizontal rounded-box filter-nav">
      <li>
        <label class="input input-ghost flex gap-2">
          <input bind:value={filter.search} on:input={()=>changeFilter()} type="text" class="grow" placeholder="Search Name, SN, IP" />
          <Icon src={MagnifyingGlass}></Icon>
        </label>
      </li> 
      <li class="nav-spacer"></li>
      <li style="flex-wrap:nowrap; flex-direction:row;">
        <span class="text-success " use:OverlayMenuService.tooltip data-tooltip="Connected">{sourceState.quickState.detail[0].count}</span><span>/</span>
        <span class="text-error" use:OverlayMenuService.tooltip data-tooltip={"Errors ("+sourceState.quickState.detail[1].count+" Session Conflicts)"}>{sourceState.quickState.error}</span><span>/</span>
        <span class="text-info" use:OverlayMenuService.tooltip data-tooltip="Total">{sourceState.quickState.count}</span>
      </li>
      <li class="nav-spacer"></li>
      <li>
        <div class="form-control">
          <label class="label cursor-pointer gap-2">
            <span class="label-text text-sm">Auto-Reauth</span>
            <input 
              type="checkbox" 
              class="toggle toggle-sm" 
              checked={isAutoReauthEnabled}
              on:change={() => toggleAutoReauth(!isAutoReauthEnabled)}
              use:OverlayMenuService.tooltip 
              data-tooltip="Toggle automatic reauthentication (disable to preserve manual web UI sessions)"
            />
          </label>
        </div>
      </li>
      <li class="nav-spacer"></li>
      <li>
        <button class="btn-nav" aria-label="Batch Jobs" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Batch Jobs" on:click={()=>batchModal.showModal()}><Icon src={CodeBracket}></Icon></button>
      </li>
      <li>
        <button class="btn-nav" aria-label="Enable PTP on all devices" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Enable PTP on all devices" on:click={()=>{ ptpEnableAll() }}><Icon src={CodeBracket}></Icon></button>
      </li>
      <li>
        <button class="btn-nav" aria-label="Disable PTP on all devices" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Disable PTP on all devices" on:click={()=>{ ptpDisableAll() }}><Icon src={CodeBracketSquare}></Icon></button>
      </li>
      <li>
        <button class="btn-nav" aria-label="Set IGMP to None on all devices" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Set IGMP to None on all devices" on:click={(evt)=>{menu.open({entry:[
          {label: "Set All to IGMP None", callback: ()=>{if(confirm('Set all devices to IGMP None?')) { setIgmpVersionAll("none") }}},
          {label: "Set All to IGMP v2", callback: ()=>{if(confirm('Set all devices to IGMP v2?')) { setIgmpVersionAll("v2") }}},
          {label: "Set All to IGMP v3", callback: ()=>{if(confirm('Set all devices to IGMP v3?')) { setIgmpVersionAll("v3") }}}
        ]},evt)}}><Icon src={Microphone}></Icon></button>
      </li>
      <li>
        <button class="btn-nav" aria-label="Restart all devices" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Restart all devices" on:click={()=>{ if(confirm('Restart all devices?')) { restartAll() } }}><Icon src={ArrowPath}></Icon></button>
      </li>
      <li>
        <button class="btn-nav" aria-label="Manual NMOS Registry" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Manual NMOS Registry" on:click={()=>nmosRegistryModal.showModal()}><Icon src={Cog}></Icon></button>
      </li>
      <li>
        <button class="btn-nav" aria-label="Show or Hide Columns" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Show or Hide Cols." on:click={()=>tableModal.showModal()}><Icon src={EllipsisVertical}></Icon></button>
      </li>
    </ul>

    
    <ScrollArea>
      <table class="data-table">

    <thead>
        <tr>
            {#each tableCols as col}
                {#if !filter.hiddenCols.includes(col.id)}
                    <td class="{(col.fixed ? "data-table-fixed-col":"")}" style="{ filter.widthCols.hasOwnProperty(col.id) ? "min-width:"+filter.widthCols[col.id]+"px;":""} {col.fixedOffset ? "left:"+col.fixedOffset+"px;":""}">
                      <div class="table-cell">
                        <div class="table-content">{col.name}</div>
                        <div class="table-functions">
                       {#if col.sortable}
                         {#if filter.sort && filter.sort.id === col.id}
                           {#if filter.sort.dir === "down"}
                             <button class="btn btn-circle btn-ghost" on:click={()=>{toggleSort(col.id)}}>
                               <Icon class="text-info" src={BarsArrowDown}></Icon>
                             </button>
                           {:else}
                             <button class="btn btn-circle btn-ghost" on:click={()=>{toggleSort(col.id)}}>
                               <Icon class="text-info" src={BarsArrowUp}></Icon>
                             </button>
                           {/if}
                         {:else}
                           <button class="btn btn-circle btn-ghost" on:click={()=>{toggleSort(col.id)}}>
                             <Icon class="" src={BarsArrowDown}></Icon>
                           </button>
                         {/if}
                       {/if}

                        </div>
                      </div>
                      {#if col.resize}
                        <div class="resize-handler" draggable={true}
                          role="separator"
                          aria-label="Resize column"
                          on:dragstart={(e)=>{startResizeDrag(e,col.id)}}
                          on:drag={(e)=>{updateResizeDrag(e,col.id)}}
                          on:dragend={(e)=>{endResizeDrag(e,col.id)}}
                        ></div>
                      {/if}
                    </td>
                {/if}
            {/each}

            <td>
            <button class="btn btn-error btn-circle" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Force Reload all, Close other Sessions" on:click={()=>{forceReloadAll()}}>
                            <Icon src={ArrowPath}></Icon>
                        </button> 
          </td>
        </tr>
    </thead>
    <tbody>
        {#each list as dev (dev.sn)}
            <tr class={"det-device"}>
                {#each tableCols as col}
                    {#if !filter.hiddenCols.includes(col.id)}
                        <td class="{(col.fixed ? "data-table-fixed-col":"")}" style="{col.fixedOffset ? "left:"+col.fixedOffset+"px;":""}">

                          {#if col.id == "state"}
                          <div class="badge badge-{ dev.failed ? (dev.sessionConflict ? "warning":"error") : "success"} badge-sm" data-tooltip-position="right,bottom" use:OverlayMenuService.tooltip data-tooltip={dev.error}></div>
                          {/if}

                            {#if col.id == "sn"}
                            <span>{dev.sn}</span>
                            {/if}


                            {#if col.id == "name"}
                            {#if batchActive}
                                <button class="btn btn-error btn-circle" data-tooltip-position="right,bottom" use:OverlayMenuService.tooltip data-tooltip="Send Batch Command" on:click={()=>{batchJob(dev.sn)}}>
                                  <Icon src={CodeBracket}></Icon>
                              </button> 
                              {/if}
                            {dev.name} <small>({dev.direction})</small>
                            {/if}

                            {#if col.id == "alias"}
                            <span>{dev.alias || ""}</span>
                            {/if}

                            {#if col.id == "type"}
                            {dev.type}
                            {/if}

                            {#if col.id == "ip"}
                            {#if dev.ipList && dev.ipList.length > 0}
                            <a href={"/device/"+dev.ipList[0]+"/access"} target="_blank" rel="noopener noreferrer">{dev.ipList[0]}</a>
                            {/if}
                            {/if}

                            {#if col.id == "bitrate"}
                            {@const totalBitrate = (dev.inputBitrate || 0) + (dev.outputBitrate || 0)}
                            {#if totalBitrate > 0}
                              <span>{totalBitrate.toFixed(1)} Mbps</span>
                            {:else}
                              <span class="text-gray-500">-</span>
                            {/if}
                            {/if}



                            {#if col.id == "network"}
                              {#each dev.linkStatus as link}
                              <div>
                                <span>
                                {#if link.up}
                                  <div class="badge badge-success" use:OverlayMenuService.tooltip data-tooltip={link.speed}></div>
                                {:else}
                                  <div class="badge badge-error"></div>
                                {/if}
                                {link.name}: {link.ip}
                              </span>
                              </div>
                              {/each}
                            {/if}



                            {#if col.id == "fwversion"}
                            {dev.firmwareVersion}
                            {#if dev.safeMode}
                              Safe Mode
                            {/if}
                            {#if dev.goldenMode}
                              Golden Mode
                            {/if}
                            {/if}

                            {#if col.id == "fwmode"}
                            {dev.simpleMode}
                            {/if}


                            {#if col.id == "temperature"}
                            {dev.temperature}
                            {/if}



                            {#if col.id == "frontpanelLock"}
                              {#if dev.frontpanelLock}
                                Locked
                              {:else}
                                Unlocked
                              {/if}
                            {/if}

                            {#if col.id == "hdcpEnabled"}
                            {#if dev.hdcpEnabled}
                                <div class="badge badge-success badge-sm"></div>
                              {:else}
                                <div class="badge badge-info badge-outline badge-sm"></div>
                              {/if}
                            {/if}

                            {#if col.id == "jpegxsLicensed"}
                              {#if dev.jpegxsLicensed}
                                <div class="badge badge-success badge-sm"></div>
                              {:else}
                                <div class="badge badge-error badge-outline badge-sm">Disabled</div>
                              {/if}
                            {/if}

                            {#if col.id == "audioStreamEnabled"}
                              {@const audioState = getAudioStreamState(dev)}
                              <div class="badge {audioState.enabled ? 'badge-success' : 'badge-ghost'}">
                                {audioState.enabled ? `${audioState.type.toUpperCase()} Enabled` : 'Disabled'}
                              </div>
                            {/if}

                            {#if col.id == "txAudioStream0Enabled"}
                              {#if dev.txAudioStream0Enabled}
                                <div class="badge badge-success badge-sm">Enabled</div>
                              {:else}
                                <div class="badge badge-error badge-outline badge-sm">Disabled</div>
                              {/if}
                            {/if}

                            {#if col.id == "rxAudioStream0Enabled"}
                              {#if dev.rxAudioStream0Enabled}
                                <div class="badge badge-success badge-sm">Enabled</div>
                              {:else}
                                <div class="badge badge-error badge-outline badge-sm">Disabled</div>
                              {/if}
                            {/if}


                            {#if col.id == "flowMode"}
                              {dev.flowMode}
                            {/if}

                            {#if col.id == "ptpStatus"}
                            <span>
                              {#if dev.ptpStatus == "FollowerLocked" }
                              <div class="badge badge-success badge-sm"></div>
                              {:else if dev.ptpStatus == "FollowerNoLeaderFound"}
                              <div class="badge badge-error badge-sm"></div>
                              {:else}
                              <div class="badge badge-warning badge-sm"></div>
                              {/if}
                              {dev.ptpStatus}
                            </span>
                            {/if}
                            {#if col.id == "ptpDomain"}
                              {dev.ptpDomain} 

                              {#if dev.ptpDomain != sourceState.settings.ptpDomain}
                                <button class="btn btn-info btn-circle" use:OverlayMenuService.tooltip data-tooltip={"Set PTP Domain to "+sourceState.settings.ptpDomain} on:click={()=>{fixPtpDomain(dev.sn)}}>
                                  <Icon src={ArrowUturnLeft}></Icon>
                              </button> 
                              {/if}
                            {/if}

                            {#if col.id == "igmpVersion"}
                              <span class="badge badge-outline">
                                {dev.igmpVersion ? dev.igmpVersion.toUpperCase() : "NONE"}
                              </span>
                            {/if}

                            {#if col.id == "igmpMenu"}
                              <button class="btn btn-circle" on:click={(evt)=>{menu.open({entry:[
                                {
                                  label: "IGMP None",
                                  callback: ()=>{setIgmpVersion(dev.sn, "none")}
                                },
                                {
                                  label: "IGMP v2",
                                  callback: ()=>{setIgmpVersion(dev.sn, "v2")}
                                },
                                {
                                  label: "IGMP v3",
                                  callback: ()=>{setIgmpVersion(dev.sn, "v3")}
                                }
                              ]},evt)}}>
                                <Icon src={EllipsisVertical}></Icon>
                              </button>
                            {/if}

                            {#if col.id == "ptpMenu"}
                              <button class="btn btn-circle" on:click={(evt)=>{menu.open({entry:[
                                {
                                  label: dev.ptpEnabled ? "Disable PTP" : "Enable PTP",
                                  callback: ()=>{togglePtp(dev.sn, !dev.ptpEnabled)}
                                }
                              ]},evt)}}>
                                <Icon src={EllipsisVertical}></Icon>
                              </button>
                            {/if}

                            {#if col.id == "audioMenu"}
                              {@const audioState = getAudioStreamState(dev)}
                              <button class="btn btn-circle" on:click={(evt)=>{menu.open({entry:[
                                {
                                  label: audioState.enabled ? `Disable ${audioState.label}` : `Enable ${audioState.label}`,
                                  callback: ()=>{toggleAudioStream(dev.sn, audioState.type, 0, !audioState.enabled)}
                                }
                              ]},evt)}}>
                                <Icon src={EllipsisVertical}></Icon>
                              </button>
                            {/if}

                            {#if col.id == "restartMenu"}
                              <button class="btn btn-error btn-circle" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Restart device" on:click={()=>{ if(confirm('Restart device '+dev.name+' ('+dev.sn+')?')) { restartDevice(dev.sn) } }}>
                                <Icon src={ArrowPath}></Icon>
                              </button>
                            {/if}







                            {#if col.id == "masterEnabled"}
                            <div class="table-cell">
                              <div class="table-content"></div>
                              <div class="table-functions"></div>
                              </div>
                              <div class="badge badge-{ dev.masterEnabled ? "success" : "error"} badge-sm"></div>
                            {/if}

                            {#if col.id == "masterEnabledMenu"}


                                <button class="btn btn-circle" aria-label="Enable Master" on:click={(evt)=>{menu.open({entry:[{
                                  label:"Enable",callback:()=>{enableMaster(dev.sn)}
                                }]},evt)}}>
                                  <Icon src={EllipsisVertical}></Icon>
                                </button>


                                
                                {/if}

                            {#if dev.direction == "tx"}

                                {#if col.id == "audioFormat"}
                                  {#if dev.inputAudioPresent}
                                    { dev.inputAudio }
                                    {:else}
                                      <div class="badge badge-info badge-outline badge-sm"></div>
                                      Not present
                                    {/if}
                                {/if}
                                {#if col.id == "inputResolution"}
                                    {#if dev.inputPresent}
                                    
                                      <div class="badge badge-success badge-sm"></div>
                                      {dev.inputResolution}
                                    
                                    {:else}
                                    
                                      <div class="badge badge-info badge-outline badge-sm"></div>
                                      Not present
                                    
                                    {/if}
                                {/if}

                                {#if col.id == "scalerMode"}
                                <div class="table-cell">
                                  <div class="table-content"></div>
                                  <div class="table-functions"></div>
                                </div>
                                  {dev.outputMode}

                                  {/if}
                                  {#if col.id == "scalerModeMenu"}
                                  <button class="btn btn-circle" aria-label="Scaler Mode Menu" on:click={(evt)=>{menu.open(getMenuTxScalerMode(dev),evt)}}>
                                    <Icon src={EllipsisVertical}></Icon>
                                  </button>
                                {/if}

                                {#if col.id == "outputResolution"}
                                    

                                    {#if dev.outputPresent}
                                          {dev.outputResolution}
                                    {:else}
                                        Not active
                                    {/if}
                                {/if}

                                {#if col.id == "edidModeMenu"}
                                  <button class="btn btn-circle" on:click={(evt)=>{menu.open(getMenuInputEdid(dev),evt)}}>
                                    <Icon src={EllipsisVertical}></Icon>
                                  </button>
                                  {/if}

                                


                            {/if}

                            {#if dev.direction == "rx"}

                            {#if col.id == "audioFormat"}
                              {#if dev.inputAudioPresent}
                                { dev.inputAudio }
                              {:else}
                                  <div class="badge badge-info badge-outline badge-sm"></div>
                                  Not present
                                {/if}
                              {/if}

                                {#if col.id == "inputResolution"}

                                {#if dev.inputPresent}
                                
                                        <div class="badge badge-success badge-sm"></div>
                                        {dev.inputResolution}
                                      
                                        
                                    {:else}
                                        
                                    
                                          <div class="badge badge-info badge-outline badge-sm"></div>
                                          Not present
                                        
                                    {/if}

                                    {/if}

                                {#if col.id == "scalerMode"}
                                {formatRxScalerMode(dev)}
                                {/if}

                                {#if col.id == "scalerModeMenu"}

                                <button class="btn btn-circle" aria-label="Scaler Mode Menu" on:click={(evt)=>{menu.open(getMenuRxScalerMode(dev),evt)}}>
                                  <Icon src={EllipsisVertical}></Icon>
                                </button>


                                
                                {/if}

                                {#if col.id == "outputResolution"}
                                  {dev.outputResolution || dev.monitorResolution}
                                {/if}

                            
                            {/if}

                            {#if col.id == "edidNativeResInput"}
                            {dev.edidNativeResInput}
                            {/if}

                            {#if col.id == "edidInput"}
                            {dev.edidInput}

                            {/if}

                            {#if col.id == "edidMonitor"}
                            {dev.edidMonitor}
                                {/if}

                                {#if col.id == "edidNativeResMonitor"}
                                {dev.edidNativeResMonitor}
                                {/if}
                        </td>
                    {/if}
                {/each}
                <td>
                    {#if dev.loading}
                        <button class="btn btn-circle btn-info" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Reload Active">
                            <Icon src={ArrowPath}></Icon>
                        </button>
                    {:else if dev.sessionConflict}
                        <button class="btn btn-error btn-circle" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Force Reload, Close other Sessions" on:click={()=>{forceReload(dev.sn)}}>
                            <Icon src={ArrowPath}></Icon>
                        </button>
                    {:else}
                        <button class="btn btn-circle" data-tooltip-position="left,bottom" use:OverlayMenuService.tooltip data-tooltip="Force Reload, Close other Sessions" on:click={()=>{forceReload(dev.sn)}}>
                            <Icon src={ArrowPath}></Icon>
                        </button>
                    {/if}
                </td>
            </tr>
        {/each}
    </tbody>

  </table>
</ScrollArea>

    
  </div>

  <dialog bind:this={editorModal} class="modal">
    <div class="modal-box">
      {#if activeEditorType == "flow"}
      <SetupFlow flowId={activeEditorId}></SetupFlow>
      {/if}

      {#if activeEditorType == "device"}
      <SetupDevice deviceId={activeEditorId}></SetupDevice>
      {/if}

      <div class="modal-action">
      </div>
    </div>
  </dialog>


  <dialog bind:this={tableModal} class="modal">
    <div class="modal-box">
      <form method="dialog">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
      </form>
      <h3>Hide Table Cols</h3>
      {#each tableCols as col}
      {#if col.name != "" && col.canHide}
      <div class="form-control">
        <label class="label cursor-pointer">
          <span class="label-text">{col.name}</span> 
          <input type="checkbox" checked={filter.hiddenCols.includes(col.id)} on:change={()=>{toggleHiddenCol(col.id);}} class="checkbox" />
        </label>
      </div>
      {/if}
      {/each}
      <div class="modal-action">
          <button class="btn" on:click={()=>{toggleHiddenCol("")}}>Show All</button>
      </div>
    </div>
  </dialog>



  <dialog bind:this={batchModal} class="modal">
    <div class="modal-box">
      <form method="dialog">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
      </form>
      <h3>Batch Job</h3>
      <div class="form-control">
        <label class="label cursor-pointer gap-2">
          <span class="label-text">Batch Visible</span> 
          <input bind:checked={batchActive} type="checkbox" class="toggle" />
        </label>
        <label class="label cursor-pointer">
          <span class="label-text">Batch JSON (Context API)</span> 
          <textarea on:input={()=>saveFilter()} bind:value={filter.batchJob} class="textarea textarea-bordered"></textarea>
        </label>
        <label class="label cursor-pointer gap-2">
          <span class="label-text">Reboot After Command</span> 
          <input on:input={()=>saveFilter()} bind:checked={filter.batchJobReboot} type="checkbox" class="toggle" />
        </label>
      </div>
      
    </div>
  </dialog>


  <dialog bind:this={nmosRegistryModal} class="modal">
    <div class="modal-box">
      <form method="dialog">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
      </form>
      <h3>Manual NMOS Registry</h3>
      <div class="form-control">
        <label class="label" for="nmos-registry-ip">
          <span class="label-text">Registry IP Address</span>
        </label>
        <input 
          id="nmos-registry-ip"
          type="text" 
          placeholder="192.168.1.100" 
          class="input input-bordered" 
          bind:value={filter.nmosRegistryIp} 
          on:input={()=>saveFilter()}
        />
        
        <label class="label mt-4" for="nmos-registry-port">
          <span class="label-text">Registry Port</span>
        </label>
        <input 
          id="nmos-registry-port"
          type="number" 
          placeholder="80" 
          class="input input-bordered" 
          bind:value={filter.nmosRegistryPort} 
          on:input={()=>saveFilter()}
        />
        
        <div class="modal-action">
          <button class="btn btn-primary" on:click={setManualNmosRegistry}>Set Registry</button>
          <button class="btn" on:click={()=>nmosRegistryModal.close()}>Cancel</button>
        </div>
      </div>
      
    </div>
  </dialog>