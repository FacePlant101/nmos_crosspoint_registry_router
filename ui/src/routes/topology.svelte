<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService"
    import { writable } from 'svelte/store';
      import type { Subject } from "rxjs";
      import { onDestroy, onMount } from "svelte";

      import SwitchNode from "../lib/SvelteFlowNodes/SwitchNode.svelte"
      import DeviceNode from "../lib/SvelteFlowNodes/DeviceNode.svelte"

      import {
            SvelteFlow,
            Controls,
            MiniMap
        } from '@xyflow/svelte';

        import type { Node, Edge } from '@xyflow/svelte';
        import { ConnectionMode } from '@xyflow/svelte';

        import '@xyflow/svelte/dist/style.css';
  
    type UIInterface = { id: string; attached?: { name?: string; chassisId?: string; portId?: string } | null };
    type UIInfraDevice = { name?: string; interfaces?: UIInterface[] } & Record<string, any>;
    let state: { devices: any[]; infrastructure: UIInfraDevice[] } = {
      devices:[],
      infrastructure:[]
    };

    // Layout persistence (localStorage)
    const layoutStorageKey = 'topology_layout_v1';
    let savedLayout: Record<string, { x: number; y: number }> = {};
    try {
      const raw = localStorage.getItem(layoutStorageKey);
      if (raw) savedLayout = JSON.parse(raw) || {};
    } catch {}
    const persistLayout = () => {
      try { localStorage.setItem(layoutStorageKey, JSON.stringify(savedLayout)); } catch {}
    };
    const deviceKey = (dev: UIInfraDevice | undefined | null): string | null => {
      if (!dev) return null;
      if ((dev as any).serialNumber) return String((dev as any).serialNumber);
      if (dev.name) return String(dev.name);
      return null;
    };
    let didMigrateLayout = false;
    const migrateLayoutBySerial = (infra: UIInfraDevice[]) => {
      if (didMigrateLayout) return;
      let changed = false;
      for (const dev of infra) {
        if (!dev) continue;
        const serial = (dev as any)?.serialNumber ? String((dev as any).serialNumber) : null;
        const nameKey = dev?.name ? String(dev.name) : null;
        if (serial && nameKey && savedLayout[nameKey] && !savedLayout[serial]) {
          savedLayout[serial] = savedLayout[nameKey];
          // Optionally remove the old key to reduce clutter
          delete savedLayout[nameKey];
          changed = true;
        }
      }
      if (changed) persistLayout();
      didMigrateLayout = true;
    };
    // Normalize a MAC-like string to lowercase hex without separators
    function normalizeMac(v: string | undefined | null): string {
      return String(v || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    }
    // Produce candidate forms of a port id for matching across formats
    function normalizePortCandidates(port: string | number | undefined | null): string[] {
      const s = String(port ?? '').trim();
      if (!s) return [];
      const out = new Set<string>();
      out.add(s);
      const digitsColon = s.replace(/[^0-9:]/g, '');
      if (digitsColon) out.add(digitsColon);
      const digitsOnly = s.replace(/[^0-9]/g, '');
      if (digitsOnly) out.add(digitsOnly);
      const parts = s.split('/');
      if (parts.length > 1) {
        const last = parts[parts.length - 1];
        out.add(last);
        const lastDigits = last.replace(/[^0-9:]/g, '');
        if (lastDigits) out.add(lastDigits);
      }
      const ci = digitsColon.indexOf(':');
      if (ci > 0) out.add(digitsColon.substring(0, ci));
      return Array.from(out);
    }
    let nodeIdToKey = new Map<string, string>();

    const nodeTypes = {
      switch: SwitchNode,
      device: DeviceNode
    }
  
    let sync:Subject<any> ;
  
    onMount(async () => {
      sync = ServerConnector.sync("topology")
          sync.subscribe((obj:any)=>{
        state = obj;
        renderState();
      });
      });
  
    onDestroy(() => {
      sync.unsubscribe();
          ServerConnector.unsync("topology")
    });


      let nodes = writable<Node[]>([]);
      let edges = writable<Edge[]>([]);
      let containerHeight = 500;

      function renderState(){
        const infra = state?.infrastructure || [];
        // Migrate saved layout keys to serialNumber-based keys when available
        migrateLayoutBySerial(infra);
        const count = infra.length;
        const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
        const spacingX = 300;
        const spacingY = 220;
        const offsetX = 50;
        const offsetY = 50;
        let n:any[] = [];
        // Build nodes and index by name and chassisId for robust matching
        const nameToIndex = new Map<string, number>();
        const chassisToIndex = new Map<string, number>();
        const macToIndex = new Map<string, number>();
        infra.forEach((dev, idx)=>{
          if (dev) {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const x = offsetX + col * spacingX;
            const y = offsetY + row * spacingY;
            const key = deviceKey(dev);
            // Use saved position if available
            const saved = key ? savedLayout[key] : undefined;
            n.push({
              id: ''+idx,
              type: 'switch',
              data: dev,
              position: saved ? { x: saved.x, y: saved.y } : { x, y }
            });
            if (key) nodeIdToKey.set(''+idx, key);
            if (dev.name) nameToIndex.set(String(dev.name).trim().toLowerCase(), idx);
            if ((dev as any).serialNumber) chassisToIndex.set(String((dev as any).serialNumber).trim().toLowerCase(), idx);
            if (Array.isArray((dev as any).interfaces)) {
              for (const it of (dev as any).interfaces) {
                const mac = normalizeMac(it?.mac);
                if (mac) macToIndex.set(mac, idx);
              }
            }
          }
        });
        nodes.set(n);
        
        // Build edges based on LLDP attached info between known switches
        const e:any[] = [];
        const seen = new Set<string>();
        infra.forEach((dev, idx)=>{
          const srcId = ''+idx;
          const ifaces = (dev && dev.interfaces) ? dev.interfaces : [];
          ifaces.forEach((int:any)=>{
            const remoteNameRaw = int?.attached?.name as string | undefined;
            const remoteChassisRaw = int?.attached?.chassisId as string | undefined;
            if (!remoteNameRaw && !remoteChassisRaw) return;
            const remoteName = remoteNameRaw ? remoteNameRaw.trim().toLowerCase() : undefined;
            const remoteChassis = remoteChassisRaw ? remoteChassisRaw.trim().toLowerCase() : undefined;
            let tgtIdx = (remoteName ? nameToIndex.get(remoteName) : undefined);
            if (tgtIdx === undefined && remoteChassis) {
              // Try serial (legacy) then MAC-based mapping
              tgtIdx = chassisToIndex.get(remoteChassis);
              if (tgtIdx === undefined) {
                const byMac = macToIndex.get(normalizeMac(remoteChassis));
                if (byMac !== undefined) tgtIdx = byMac;
              }
            }
            if (tgtIdx === undefined) return; // only connect to known switches
            const tgtId = ''+tgtIdx;
            // Try to map to a specific remote handle using attached.portId
            let targetHandle: string | undefined = undefined;
            const remotePortId = int?.attached?.portId;
            const tgtDev = infra[tgtIdx];
            if (remotePortId && tgtDev && Array.isArray(tgtDev.interfaces)) {
              const match = tgtDev.interfaces.find((ri:any)=> ri && ri.id === remotePortId);
              if (match) targetHandle = match.id;
            }
            // Fallback: normalize port formats to find a matching handle
            if (!targetHandle && remotePortId && tgtDev && Array.isArray(tgtDev.interfaces)) {
              const candidates = normalizePortCandidates(remotePortId);
              const match2 = tgtDev.interfaces.find((ri:any)=> {
                const rid = String(ri?.id ?? '');
                const rnum = String(ri?.num ?? '');
                return candidates.includes(rid) || candidates.includes(rnum);
              });
              if (match2) targetHandle = match2.id;
            }
            // De-duplicate symmetric reports by unordered node ids + handles
            const nodeKey = [srcId, tgtId].sort().join('-');
            const handleKey = [int.id || '', targetHandle || ''].sort().join('-');
            const key = `${nodeKey}|${handleKey}`;
            if (seen.has(key)) return;
            seen.add(key);
            e.push({
              id: `e-${srcId}-${int.id}-${tgtId}-${targetHandle || ''}`,
              source: srcId,
              target: tgtId,
              sourceHandle: int.id,
              targetHandle: targetHandle
            });
          });
        });
        edges.set(e);
        const rows = Math.max(1, Math.ceil(count / cols));
        containerHeight = Math.max(500, offsetY + rows * spacingY + 100);
      }

      function handleNodeDragStop(event: any) {
        const node = event?.detail?.node as Node | undefined;
        if (!node) return;
        const key = nodeIdToKey.get(node.id) || deviceKey((node as any).data);
        if (!key) return;
        savedLayout[key] = { x: node.position.x, y: node.position.y };
        persistLayout();
      }
    
  </script>
  

  <div class="topology-container" style:height={containerHeight + 'px'}>
    <SvelteFlow
      connectionMode={ConnectionMode.Loose}
      {nodes}
      {edges}
      {nodeTypes}
      fitView
      on:nodedragstop={handleNodeDragStop}
      on:nodeclick={(event) => console.log('on node click', event.detail.node)}
    >
      <Controls />
      <MiniMap />
    </SvelteFlow>
  </div>