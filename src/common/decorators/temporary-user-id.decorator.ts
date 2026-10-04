import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * The header a client presents its user id in while authentication does not
 * exist yet.
 *
 * `X-User-Id` is a *claimed* identity, not a proven one: any caller that knows a
 * UUID can send it. It exists so the user-scoped features (the cart, the
 * wishlist) have a real owner to key rows by — one cart and one wishlist per
 * user, owner-scoped reads, 404 on another user's row — instead of a placeholder
 * that would have to be thrown away when auth arrives.
 */
export const TEMPORARY_USER_ID_HEADER = 'x-user-id';

/**
 * Temporary stand-in for the authenticated principal, reading
 * {@link TEMPORARY_USER_ID_HEADER} from the request.
 *
 * **This is not authentication.** There is no signature, no token and no session,
 * so any caller may claim any user id. It is the smallest mechanism that gives a
 * user-scoped feature a well-defined owner, and it is isolated in this one file
 * so replacing it with a guard derived from a verified credential is a change to a
 * single decorator: the controllers already receive the user id as a parameter
 * and know nothing about where it came from.
 *
 * It lives in `common/decorators` rather than in any one feature because it is
 * feature-agnostic: several aggregates are keyed by a user, and each of them
 * needs the same claim in the same shape. Duplicating the decorator per feature
 * would give the same header two subtly different implementations.
 *
 * Apply `ParseUUIDPipe` to it — `@TemporaryUserId(new ParseUUIDPipe())` — so a
 * missing or malformed header is rejected with 400 before the service runs, the
 * same way every other id in this project is validated. Passing the pipe here
 * rather than validating by hand is what keeps that behaviour identical to
 * `@Param('id', ParseUUIDPipe)`.
 *
 * No user *record* is loaded here. The decorator only resolves the identity; each
 * service verifies the user exists, so a claim of a deleted or non-existent user
 * fails as a 404 instead of silently creating rows nobody owns.
 */
export const TemporaryUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const header = request.headers[TEMPORARY_USER_ID_HEADER];

    return Array.isArray(header) ? header[0] : header;
  },
);
