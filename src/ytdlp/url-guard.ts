import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

import { AppError } from '../common/errors';

/**
 * Address ranges a caller-supplied URL may never reach (SPEC §12): private, loopback,
 * link-local (incl. cloud metadata), CGNAT, documentation, multicast and reserved space.
 * Docker's egress filter blocks the same ranges again at the network layer.
 */
const BLOCKED_IPV4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV6: readonly [string, number][] = [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64 can reach embedded IPv4
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, incl. Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 embeds IPv4
  ['fc00::', 7], // unique local, incl. fd00:ec2::254 (AWS metadata)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4) blockList.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_IPV6) blockList.addSubnet(network, prefix, 'ipv6');

const MAX_URL_LENGTH = 2048;
const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export function isBlockedAddress(address: string): boolean {
  const mapped = MAPPED_IPV4.exec(address)?.[1];
  if (mapped !== undefined) return isBlockedAddress(mapped);
  if (isIPv4(address)) return blockList.check(address, 'ipv4');
  if (isIPv6(address)) return blockList.check(address, 'ipv6');
  return true;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, order: 'verbatim' })).map((entry) => entry.address);

function reject(message: string): never {
  throw new AppError('URL_NOT_ALLOWED', message);
}

/**
 * Validates a caller-supplied media URL before any subprocess sees it: http(s) only, no
 * credentials, and every address the host resolves to must be public.
 */
export async function guardUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  if (raw.length > MAX_URL_LENGTH) reject(`URLs are limited to ${MAX_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    reject('Only http and https URLs are allowed');
  if (url.username !== '' || url.password !== '') reject('URLs must not contain credentials');

  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') reject('The URL has no host');
  let addresses: string[];
  if (isIPv4(host) || isIPv6(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      reject(`The host ${host} could not be resolved`);
    }
  }
  if (addresses.length === 0) reject(`The host ${host} could not be resolved`);
  if (addresses.some(isBlockedAddress)) reject('The URL points to a private or reserved address');
  return url;
}
