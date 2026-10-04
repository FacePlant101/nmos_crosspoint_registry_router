/**
 * Crosspoint flow addresses, as sent by the UI, Q-SYS and other control systems:
 *
 *   "Dev"      device level (every video flow)
 *   "Dev.v2"   video flow 2      ("a" audio, "d" data, "u" any other type)
 *   "Dev.v"    every video flow
 *   "Dev.2"    video flow 2 (channel-number shorthand, e.g. multiviewer quadrants)
 *
 * Flow numbers are the 1-based `num` the crosspoint assigns per device, direction and type,
 * so they are used as-is: there is no 0-based variant for any kind of device.
 */

export type FlowAddressType = "video" | "audio" | "data" | "other";

/** Flow types an "other" ("u") address covers; the UI renders all of them as "u". */
export const OTHER_FLOW_TYPES = ["audiochannel", "websocket", "mqtt", "unknown"];

export interface FlowAddress {
    device: string;
    /** null: device-level address */
    type: FlowAddressType | null;
    /** null: every flow of `type` */
    num: number | null;
}

const TYPE_PREFIX: Record<string, FlowAddressType> = { v: "video", a: "audio", d: "data", u: "other" };
const FLOW_SUFFIX = /^(?:([vadu])(\d*)|(\d+))$/;

export function parseFlowAddress(address: string): FlowAddress {
    const dot = address.lastIndexOf(".");
    if (dot > 0) {
        const match = FLOW_SUFFIX.exec(address.slice(dot + 1));
        if (match) {
            const device = address.slice(0, dot);
            if (match[3] !== undefined) {
                return { device, type: "video", num: parseInt(match[3], 10) };
            }
            return {
                device,
                type: TYPE_PREFIX[match[1]],
                num: match[2] === "" ? null : parseInt(match[2], 10),
            };
        }
    }
    // No recognisable flow suffix: the whole string names the device (names may contain dots).
    return { device: address, type: null, num: null };
}
