import type { ViceMeClient } from '../core/client.ts';

interface DanmakuIntegration {
  focus(): void;
  setTipAvailable(available: boolean): void;
}

interface TipIntegration {
  open(): void;
}

interface IntegrationEntry {
  danmaku?: DanmakuIntegration;
  tip?: TipIntegration;
}

const integrations = new WeakMap<ViceMeClient, WeakMap<Element, IntegrationEntry>>();

function getEntry(
  client: ViceMeClient,
  target: Element,
  create: boolean,
): IntegrationEntry | undefined {
  let byTarget = integrations.get(client);
  if (!byTarget && create) {
    byTarget = new WeakMap();
    integrations.set(client, byTarget);
  }
  let entry = byTarget?.get(target);
  if (!entry && create) {
    entry = {};
    byTarget!.set(target, entry);
  }
  return entry;
}

export function registerIntegratedDanmaku(
  client: ViceMeClient,
  target: Element,
  danmaku: DanmakuIntegration,
): () => void {
  const entry = getEntry(client, target, true)!;
  entry.danmaku = danmaku;
  if (entry.tip) danmaku.setTipAvailable(true);
  return () => {
    const current = getEntry(client, target, false);
    if (current?.danmaku !== danmaku) return;
    delete current.danmaku;
    if (!current.tip) integrations.get(client)?.delete(target);
  };
}

export function registerIntegratedTip(
  client: ViceMeClient,
  target: Element,
  tip: TipIntegration,
): () => void {
  const entry = getEntry(client, target, true)!;
  entry.tip = tip;
  entry.danmaku?.setTipAvailable(true);
  return () => {
    const current = getEntry(client, target, false);
    if (current?.tip !== tip) return;
    delete current.tip;
    current.danmaku?.setTipAvailable(false);
    if (!current.danmaku) integrations.get(client)?.delete(target);
  };
}

export function hasIntegratedTip(client: ViceMeClient, target: Element): boolean {
  return getEntry(client, target, false)?.tip !== undefined;
}

export function openIntegratedTip(client: ViceMeClient, target: Element): void {
  getEntry(client, target, false)?.tip?.open();
}

export function focusIntegratedDanmaku(client: ViceMeClient, target: Element): void {
  getEntry(client, target, false)?.danmaku?.focus();
}
