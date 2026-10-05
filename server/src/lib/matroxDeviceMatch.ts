/**
 * Map NMOS resources to the Matrox ConvertIP devices the Matrox module manages.
 *
 * Router aliases and NMOS labels are user editable and the crosspoint device number is
 * the router's own numbering, so none of them identify a Matrox device. The NMOS node
 * does: it lists the device's API addresses, and Matrox encodes the serial in its id.
 */

export interface MatroxDeviceRef {
    sn: string;
    ipList: string[];
}

/**
 * Serial number encoded in a Matrox node id ("<sn>[0]-...-<x>0000000000"),
 * or null for ids that are not Matrox node ids.
 */
export function matroxSerialFromNodeId(nodeId: string): string | null {
    const parts = nodeId.split("-");
    if (parts.length < 2 || !parts[parts.length - 1].endsWith("0000000000")) {
        return null;
    }
    let sn = parts[0];
    if (sn[sn.length - 1] == "0") {
        sn = sn.slice(0, sn.length - 1);
    }
    return sn;
}

/**
 * Key of the Matrox device behind an NMOS node: by API address first (survives
 * serial de-duplication renaming the key), then by the serial in the node id.
 */
export function findMatroxDeviceKey(devices: Record<string, MatroxDeviceRef>, node: any): string | null {
    const hosts: string[] = (node?.api?.endpoints ?? []).map((ep: any) => ep?.host).filter(Boolean);
    for (const key of Object.keys(devices)) {
        if ((devices[key].ipList ?? []).some(ip => hosts.includes(ip))) {
            return key;
        }
    }

    const sn = typeof node?.id === "string" ? matroxSerialFromNodeId(node.id) : null;
    if (sn) {
        const wanted = sn.toLowerCase();
        for (const key of Object.keys(devices)) {
            if (key.toLowerCase() === wanted || (devices[key].sn ?? "").toLowerCase() === wanted) {
                return key;
            }
        }
    }
    return null;
}
