import {
  getSubagentsService,
  unpublishSubagentsService,
} from "#src/service/service";

/** Remove the service currently published by one disposed child session. */
export function unpublishCurrentSubagentsService(ownerSessionId: string): void {
  const service = getSubagentsService(ownerSessionId);
  if (service) unpublishSubagentsService(ownerSessionId, service);
}
