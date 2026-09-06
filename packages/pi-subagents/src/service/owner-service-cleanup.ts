import {
  getSubagentsService,
  type SubagentsService,
  unpublishSubagentsService,
} from "#src/service/service";

const OWNER_SERVICE_RELEASES_KEY = Symbol.for("@gotgenes/pi-subagents:owner-service-releases");

export type DisposedChildOwnerRelease = (reason: "disposed-child") => void;

interface OwnerServiceReleaseRegistry {
  readonly releases: WeakMap<SubagentsService, DisposedChildOwnerRelease>;
}

/** Register the release callback bound to one exact published service object. */
export function registerSubagentsServiceOwnerRelease(
  service: SubagentsService,
  release: DisposedChildOwnerRelease,
): () => void {
  const registry = getOwnerServiceReleaseRegistry();
  registry.releases.set(service, release);
  return () => {
    if (registry.releases.get(service) === release) registry.releases.delete(service);
  };
}

/** Release and unpublish only the service currently published by a disposed child session. */
export function unpublishCurrentSubagentsService(ownerSessionId: string): void {
  const service = getSubagentsService(ownerSessionId);
  if (!service) return;
  try {
    getOwnerServiceReleaseRegistry().releases.get(service)?.("disposed-child");
  } finally {
    unpublishSubagentsService(ownerSessionId, service);
  }
}

function getOwnerServiceReleaseRegistry(): OwnerServiceReleaseRegistry {
  const existing = (globalThis as Record<symbol, unknown>)[OWNER_SERVICE_RELEASES_KEY];
  if (existing !== undefined) {
    if (!isOwnerServiceReleaseRegistry(existing)) {
      throw new Error("Subagents owner-release registry has an invalid process-global value.");
    }
    return existing;
  }
  const registry: OwnerServiceReleaseRegistry = { releases: new WeakMap() };
  Object.defineProperty(globalThis, OWNER_SERVICE_RELEASES_KEY, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

function isOwnerServiceReleaseRegistry(value: unknown): value is OwnerServiceReleaseRegistry {
  return value !== null && typeof value === "object" && Reflect.get(value, "releases") instanceof WeakMap;
}
