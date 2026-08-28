/** Stable, allowlisted `viceme:*` DOM events shared by hosted capabilities. */

import type { ViceMeErrorCode } from './core/errors.ts';

export interface VicemeReadyDetail {
  clientKey: string;
  workKey: string;
  capabilities: string[];
  version: string;
}

export interface VicemeCapabilityReadyDetail {
  clientKey: string;
  instanceKey: string;
  capability: string;
  version: string;
}

export interface VicemeErrorDetail {
  clientKey?: string;
  instanceKey?: string;
  capability?: string;
  code: ViceMeErrorCode;
  retryable: boolean;
  requestId?: string;
}

export interface VicemeDestroyedDetail {
  clientKey: string;
  instanceKey: string;
  capability: string;
}

export interface VicemeWidgetCloseDetail {
  workId: string;
}

export interface VicemeTipPaidDetail {
  workId: string;
  orderNo: string;
  status: 'PAID';
  amountCents: number;
}

export type VicemeEventType =
  | 'viceme:ready'
  | 'viceme:capability-ready'
  | 'viceme:error'
  | 'viceme:destroyed'
  | 'viceme:widget-close'
  | 'viceme:tip-paid';

export type VicemeEventDetailMap = {
  'viceme:ready': VicemeReadyDetail;
  'viceme:capability-ready': VicemeCapabilityReadyDetail;
  'viceme:error': VicemeErrorDetail;
  'viceme:destroyed': VicemeDestroyedDetail;
  'viceme:widget-close': VicemeWidgetCloseDetail;
  'viceme:tip-paid': VicemeTipPaidDetail;
};

const ALLOWED_KEYS: ReadonlyMap<VicemeEventType, ReadonlySet<string>> = new Map([
  ['viceme:ready', new Set(['clientKey', 'workKey', 'capabilities', 'version'])],
  ['viceme:capability-ready', new Set(['clientKey', 'instanceKey', 'capability', 'version'])],
  [
    'viceme:error',
    new Set(['clientKey', 'instanceKey', 'capability', 'code', 'retryable', 'requestId']),
  ],
  ['viceme:destroyed', new Set(['clientKey', 'instanceKey', 'capability'])],
  ['viceme:widget-close', new Set(['workId'])],
  ['viceme:tip-paid', new Set(['workId', 'orderNo', 'status', 'amountCents'])],
]);

/** Strip anything outside the documented allowlist before dispatch. */
export function sanitizeDetail(
  type: VicemeEventType,
  detail: VicemeEventDetailMap[VicemeEventType],
): VicemeEventDetailMap[VicemeEventType] {
  const allowed = ALLOWED_KEYS.get(type)!;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (allowed.has(key) && value !== undefined) result[key] = value;
  }
  return result as unknown as VicemeEventDetailMap[VicemeEventType];
}

export function dispatchViceMeEvent<K extends VicemeEventType>(
  target: EventTarget,
  type: K,
  detail: VicemeEventDetailMap[K],
): void {
  const event = new CustomEvent(type, {
    detail: sanitizeDetail(type, detail),
    bubbles: true,
    composed: true,
    cancelable: false,
  });
  target.dispatchEvent(event);
}
