import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AddressResponseDto } from './dto/address-response.dto.js';
import { CreateAddressDto } from './dto/create-address.dto.js';
import { UpdateAddressDto } from './dto/update-address.dto.js';
import {
  AddressRepository,
  type AddressTransactionClient,
  type CreateAddressData,
  type UpdateAddressData,
} from './repositories/address.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRISMA_RECORD_NOT_FOUND = 'P2025';
const ADDRESS_MODEL = 'Address';
const ADDRESSES_ONE_DEFAULT_INDEX = 'addresses_one_default_per_user_key';

/**
 * How many attempts a default-address write gets.
 *
 * Three is enough because the only way to lose is a collision on the partial unique
 * index, and a retry always re-reads the current default first. The first retry
 * effectively cannot lose again — it demotes whatever is default at that moment
 * before promoting its own target — so the third attempt exists only to absorb a
 * pathological interleaving rather than to make progress in the normal case.
 */
const DEFAULT_WRITE_ATTEMPTS = 3;

const DEFAULT_CANNOT_BE_UNSET_MESSAGE =
  'The default address cannot be unset; set another address as the default first';
const ADDRESSES_CHANGED_MESSAGE =
  'Addresses changed concurrently; retry the request';
const ADDRESS_NOT_FOUND_MESSAGE =
  'Address does not exist or does not belong to the caller';

/**
 * All address-book business rules live here; the repository only knows about SQL
 * and the controller only knows about HTTP.
 *
 * ## An address book, not a shipping record
 *
 * An address is a mutable convenience the customer keeps to make checkout faster.
 * It is not a statement about where anything was delivered, and nothing durable
 * points at it: when an order is placed it will copy these fields into its own
 * immutable snapshot rather than referencing this row. That is why an address can
 * be edited and deleted freely, and why `updated_at` exists here when it does not on
 * a saved wishlist item.
 *
 * ## The single-default rule
 *
 * A user may hold many addresses but only one may be the default, so a checkout can
 * always pre-fill itself without asking which address to use. Three layers enforce
 * it, each of which would be insufficient alone:
 *
 * 1. **A PostgreSQL partial unique index** on `(user_id) WHERE is_default = true`.
 *    This is the authority. No code path can store two defaults, whatever order the
 *    statements run in.
 * 2. **Sequenced writes inside one transaction.** Promoting a default is two
 *    statements — demote the incumbent, promote the target — and running them in a
 *    single transaction is what keeps a reader from ever seeing the intermediate
 *    state where the user has addresses but no default.
 * 3. **The service rules** below: the first address becomes the default by itself,
 *    and clearing the default is refused.
 *
 * The index is what makes (2) safe rather than merely hopeful. Two concurrent
 * promotions cannot both win: the loser's write is rejected, and
 * {@link runDefaultTransaction} retries the loser as a fresh read-modify-write, so
 * the caller gets a 200 and the database still ends up with exactly one default.
 *
 * ## Why the default cannot simply be cleared
 *
 * Allowing `isDefault: false` on the current default would leave the user with
 * addresses but no default — the one state the invariant exists to prevent, because
 * a checkout would have to stop pre-filling and start asking. Requiring an explicit
 * "make this one the default" keeps the transition a deliberate act, and it gives
 * the customer a way forward that does not depend on remembering which address is
 * current. The 409 is the honest answer: the request is well-formed and the target
 * exists, it just conflicts with the current state.
 *
 * ## Ownership
 *
 * Every single-address operation is scoped to the caller in the query itself, so
 * "no such address" and "that address belongs to somebody else" produce the same
 * 404 and one user's address book cannot be probed through another's ids.
 *
 * ## Error semantics
 *
 * | Condition                                    | Status | Rationale                                        |
 * | -------------------------------------------- | ------ | ------------------------------------------------ |
 * | Missing / malformed `X-User-Id`              | 400    | Rejected by `ParseUUIDPipe`, before the service.  |
 * | User does not exist                          | 404    | The claimed identity is not a real user.          |
 * | Malformed `:id`                              | 400    | Rejected by `ParseUUIDPipe`, before the service.  |
 * | Unknown field in the body                    | 400    | Rejected by `forbidNonWhitelisted`.               |
 * | Invalid field value, or `null` for a required field | 400 | Rejected by the DTO validator.               |
 * | Address absent, or belonging to another user | 404    | Same 404, so ownership cannot be probed.          |
 * | Clearing the current default                 | 409    | Valid target, but it conflicts with the invariant.|
 * | Lost the race for the default                | (retried) | Retried; never surfaced in the normal case.   |
 * | Still lost after every attempt               | 409    | Genuinely concurrent, and safe to retry.          |
 *
 * A foreign key violation (`P2003`) is never mapped: by the time an address is
 * written its owner has already been verified, so the only way to hit it is the user
 * being deleted concurrently — a genuine fault that must surface as a 500 rather
 * than invite the client to retry blindly.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly addressRepository: AddressRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Returns the user's address book, default first.
   *
   * A user with no addresses gets `200` and an empty list rather than a 404: "this
   * account has no saved addresses" is the normal state of a new account, and the
   * client renders an empty form for it.
   */
  async findAll(userId: string): Promise<AddressResponseDto[]> {
    await this.requireUser(userId);

    const addresses = await this.addressRepository.findAllByUserId(userId);

    return addresses.map((address) => AddressResponseDto.fromEntity(address));
  }

  /**
   * Returns one of the user's addresses, or 404.
   *
   * `client` is optional and exists for one caller: checkout, which has to copy the
   * address onto an order inside the transaction that writes that order. Passing it
   * keeps the ownership check on the same view as the write, so "this address is
   * yours" is decided by the same transaction that acts on it. Omitting it — as
   * every other caller does — reads on the default client, exactly as before.
   *
   * The address book stays owned by this service. Checkout depends on
   * `AddressesService` rather than on `AddressRepository` precisely so the
   * "one default per user" and "an address belongs to exactly one user" rules cannot
   * be re-implemented, or bypassed, by whoever needs to read one.
   */
  async findOne(
    userId: string,
    addressId: string,
    client?: AddressTransactionClient,
  ): Promise<AddressResponseDto> {
    await this.requireUser(userId);

    const address = await this.requireOwnedAddress(addressId, userId, client);

    return AddressResponseDto.fromEntity(address);
  }

  /**
   * Saves a new address for the user.
   *
   * The user's **first** address becomes the default whether or not the request
   * asked for it: an address book whose only entry is not the default is a state no
   * checkout can use, and making the client know that rule to get a working address
   * book would leak an implementation detail into every integration.
   *
   * Afterwards, `isDefault` is honoured literally — but `true` means *move* the
   * default here, so the incumbent is demoted in the same transaction.
   */
  async create(
    userId: string,
    dto: CreateAddressDto,
  ): Promise<AddressResponseDto> {
    await this.requireUser(userId);

    const address = await this.runDefaultTransaction(async (tx) => {
      const existingCount = await this.addressRepository.countByUserId(
        userId,
        tx,
      );
      const isDefault = dto.isDefault === true || existingCount === 0;

      /**
       * Demote before inserting, never after: while the incumbent still exists,
       * inserting a second default would violate the partial unique index. Doing it
       * in this order inside one transaction means the demotion and the insert
       * commit together, so no reader ever sees the user without a default.
       *
       * A user's first address has no incumbent, so the demotion is skipped rather
       * than issued as a statement that provably matches no row.
       */
      if (isDefault && existingCount > 0) {
        await this.addressRepository.demoteDefaults(userId, null, tx);
      }

      return this.addressRepository.create(
        this.buildCreateData(dto, userId, isDefault),
        tx,
      );
    });

    return AddressResponseDto.fromEntity(address);
  }

  /**
   * Applies a partial update to one of the user's addresses.
   *
   * Omitted fields keep their stored value and `null` clears a nullable one, so the
   * stored row stays the whole truth about the address.
   *
   * `isDefault` is handled apart from the field writes, because it is a request to
   * move a single slot rather than a column to write:
   *
   * - `true` on a non-default address demotes the incumbent and promotes this one in
   *   a single transaction, writing the promoted row back so the response reflects
   *   the edit and the promotion together.
   * - `true` on the address that is already the default is a no-op, so the
   *   incumbent is left alone rather than being demoted and re-promoted.
   * - `false` on the current default is a 409 (see the class comment).
   * - `false` on any other address is a no-op; it was already not the default.
   */
  async update(
    userId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<AddressResponseDto> {
    await this.requireUser(userId);

    const existing = await this.requireOwnedAddress(addressId, userId);

    if (dto.isDefault === false && existing.isDefault) {
      throw new ConflictException(DEFAULT_CANNOT_BE_UNSET_MESSAGE);
    }

    const data = buildUpdateData(dto);
    const isPromotion = dto.isDefault === true && !existing.isDefault;
    const hasFieldChanges = Object.keys(data).length > 0;

    if (!isPromotion) {
      /**
       * Nothing to do is a success, not an error. `PATCH {}` and a PATCH whose only
       * field is a no-op `isDefault` both mean "the address is as you asked", and
       * answering 200 with the unchanged row keeps a retried request idempotent
       * instead of failing on a write that would change nothing.
       */
      if (!hasFieldChanges) {
        return AddressResponseDto.fromEntity(existing);
      }

      /**
       * A plain field edit needs no transaction — it writes one row and touches
       * nothing else — but it still needs the error mapping: the address can be
       * removed by a concurrent request between the ownership read above and this
       * write, and `P2025` has to become the same 404 the read would have produced.
       */
      try {
        return AddressResponseDto.fromEntity(
          await this.addressRepository.updateByIdAndUserId(
            addressId,
            userId,
            data,
          ),
        );
      } catch (error) {
        throw this.rethrowAsHttpError(error);
      }
    }

    const updated = await this.runDefaultTransaction(async (tx) => {
      await this.addressRepository.demoteDefaults(userId, addressId, tx);

      if (hasFieldChanges) {
        await this.addressRepository.updateByIdAndUserId(
          addressId,
          userId,
          data,
          tx,
        );
      }

      /**
       * Promoted last so the row it returns already carries the new field values:
       * the response is read after the edit within the same transaction, so a client
       * never sees the promotion and the edit disagree.
       */
      return this.addressRepository.promoteByIdAndUserId(addressId, userId, tx);
    });

    return AddressResponseDto.fromEntity(updated);
  }

  /**
   * Makes one of the user's addresses the default.
   *
   * Idempotent: naming the address that is already the default succeeds and changes
   * nothing, so a client that re-sends the request after a timeout converges rather
   * than erroring.
   *
   * This is the dedicated route for the transition because "make this my default" is
   * a distinct intent from "edit this address", and a client should not have to send
   * `PATCH {"isDefault": true}` to mean it.
   */
  async setDefault(
    userId: string,
    addressId: string,
  ): Promise<AddressResponseDto> {
    await this.requireUser(userId);

    const updated = await this.runDefaultTransaction(async (tx) => {
      const address = await this.addressRepository.findByIdAndUserId(
        addressId,
        userId,
        tx,
      );

      if (address === null) {
        throw this.addressNotFound(addressId);
      }

      if (address.isDefault) {
        return address;
      }

      await this.addressRepository.demoteDefaults(userId, addressId, tx);

      return this.addressRepository.promoteByIdAndUserId(addressId, userId, tx);
    });

    return AddressResponseDto.fromEntity(updated);
  }

  /**
   * Removes one of the user's addresses.
   *
   * Deleting the default is allowed and never leaves the user without one: when
   * other addresses remain, the oldest is promoted in the same transaction. The user
   * did not ask for a particular successor, so promoting one is better than refusing
   * the delete — and refusing would leave them unable to remove a stale default at
   * all, which is the situation most likely to make them want to.
   *
   * Deleting the *only* address leaves the user with none, which is legitimate: an
   * account is allowed to have an empty address book, and the "no default" rule only
   * applies once there is something to be the default of.
   *
   * The delete runs **before** the promotion, never after. While the old default row
   * still exists, promoting a successor would briefly give the user two defaults and
   * violate the partial unique index; deleting first makes the slot free in the same
   * transaction that fills it.
   */
  async remove(userId: string, addressId: string): Promise<void> {
    await this.requireUser(userId);

    await this.runDefaultTransaction(async (tx) => {
      const address = await this.addressRepository.findByIdAndUserId(
        addressId,
        userId,
        tx,
      );

      if (address === null) {
        throw this.addressNotFound(addressId);
      }

      await this.addressRepository.deleteByIdAndUserId(addressId, userId, tx);

      if (!address.isDefault) {
        return;
      }

      const successor = await this.addressRepository.findDefaultSuccessor(
        userId,
        tx,
      );

      if (successor !== null) {
        await this.addressRepository.promoteByIdAndUserId(
          successor.id,
          userId,
          tx,
        );
      }
    });
  }

  /**
   * Runs a write that moves the default flag, retrying it when it loses a race.
   *
   * Two requests can legitimately disagree about who the default is. The partial
   * unique index settles that contest by rejecting the loser's write with `P2002`,
   * and the loser — which is this method — re-runs the whole read-modify-write
   * against the state the winner committed. Retrying is therefore the *correct*
   * response, not a workaround: after the retry the request either wins the slot or,
   * if another writer keeps overtaking it, is reported as a 409 that is genuinely
   * worth retrying.
   *
   * A `P2025` is retried for the same reason. The promotion step names a successor
   * address chosen inside the transaction; if a concurrent request deletes that
   * successor first, re-running picks a different one instead of reporting a 404
   * about an address the caller never asked about.
   *
   * A failed attempt is a rolled-back transaction, so re-running `work` cannot
   * duplicate a row or double-apply a demotion.
   */
  private async runDefaultTransaction<T>(
    work: (tx: AddressTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= DEFAULT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return await this.addressRepository.runInTransaction(work);
      } catch (error) {
        if (
          attempt < DEFAULT_WRITE_ATTEMPTS &&
          (this.isDefaultRaceViolation(error) || this.isRecordMissing(error))
        ) {
          continue;
        }

        throw this.rethrowAsHttpError(error);
      }
    }

    /* c8 ignore next 3 */
    throw new ConflictException(ADDRESSES_CHANGED_MESSAGE);
  }

  /**
   * Confirms the claimed identity is a real user.
   *
   * The temporary identity header is an unverified claim, so this check is what
   * stops a caller from writing addresses against a user id that does not exist (or
   * no longer does), which would otherwise surface as an opaque foreign key failure.
   */
  private async requireUser(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);

    if (user === null) {
      throw new NotFoundException(`User ${userId} does not exist`);
    }
  }

  /**
   * Returns the caller's address, or 404 — the same answer for an address that does
   * not exist and one owned by somebody else, so neither can be probed.
   */
  private async requireOwnedAddress(
    addressId: string,
    userId: string,
    client?: AddressTransactionClient,
  ) {
    const address = await this.addressRepository.findByIdAndUserId(
      addressId,
      userId,
      client,
    );

    if (address === null) {
      throw this.addressNotFound(addressId);
    }

    return address;
  }

  private addressNotFound(addressId: string): NotFoundException {
    return new NotFoundException(`Address ${addressId} does not exist`);
  }

  /** Copies the validated request onto the columns a create is allowed to write. */
  private buildCreateData(
    dto: CreateAddressDto,
    userId: string,
    isDefault: boolean,
  ): CreateAddressData {
    return {
      userId,
      label: dto.label,
      recipientName: dto.recipientName,
      phone: dto.phone,
      addressLine1: dto.addressLine1,
      addressLine2: dto.addressLine2 ?? null,
      city: dto.city,
      stateProvince: dto.stateProvince ?? null,
      postalCode: dto.postalCode ?? null,
      countryCode: dto.countryCode,
      isDefault,
    };
  }

  /**
   * Translates the database errors this feature can legitimately produce into HTTP
   * semantics, and rethrows everything else unchanged.
   *
   * `P2025` becomes a 404 without naming an id. By the time it escapes, the retry
   * loop has already re-read the address, so the address the caller asked about
   * really is gone or really is not theirs — but the statement that failed may have
   * been the promotion of a *successor*, and quoting that id in the message would
   * answer a question the caller never asked.
   *
   * `P2002` reaches this point only after every attempt lost the race for the default
   * slot, which is worth telling the caller to retry. `P2003` is a genuine fault and
   * is rethrown untouched so it surfaces as a 500.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (this.isRecordMissing(error)) {
        throw new NotFoundException(ADDRESS_NOT_FOUND_MESSAGE);
      }

      if (this.isDefaultRaceViolation(error)) {
        throw new ConflictException(ADDRESSES_CHANGED_MESSAGE);
      }
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on `addresses`.
   *
   * The partial index is declared in migration SQL rather than in the Prisma schema,
   * so Prisma has no name for it and reports the model instead. With driver adapters
   * such as `@prisma/adapter-pg` the meta object carries a `driverAdapterError`, so
   * the index name is matched when present and the model name is the fallback. The
   * model's only other unique constraint is the primary key, which is a
   * server-generated UUID and therefore unreachable from a write.
   */
  private isDefaultRaceViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      return false;
    }

    const meta = error.meta as
      | {
          modelName?: string;
          driverAdapterError?: {
            cause?: { constraint?: { index?: string } };
          };
        }
      | undefined;

    if (
      meta?.driverAdapterError?.cause?.constraint?.index ===
      ADDRESSES_ONE_DEFAULT_INDEX
    ) {
      return true;
    }

    return meta?.modelName === ADDRESS_MODEL;
  }

  /**
   * Detects Prisma's "the record to update or delete does not exist".
   *
   * Raised when an address the service already confirmed is the caller's is removed
   * by a concurrent request between the read and the write.
   */
  private isRecordMissing(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_RECORD_NOT_FOUND
    );
  }
}

/**
 * Copies the fields a PATCH actually supplied.
 *
 * Keys absent from the request are absent from `data`, and Prisma writes only the
 * keys it is given — that is what makes an omitted field "leave this column alone"
 * rather than "set it to undefined". A field the client sent as `null` *is* present,
 * which is how a nullable column gets cleared.
 *
 * `isDefault` is excluded here on purpose: the default flag is moved through the
 * dedicated promote/demote statements, so an ordinary field edit can never write it.
 */
function buildUpdateData(dto: UpdateAddressDto): UpdateAddressData {
  const data: UpdateAddressData = {};

  if (dto.label !== undefined) {
    data.label = dto.label;
  }

  if (dto.recipientName !== undefined) {
    data.recipientName = dto.recipientName;
  }

  if (dto.phone !== undefined) {
    data.phone = dto.phone;
  }

  if (dto.addressLine1 !== undefined) {
    data.addressLine1 = dto.addressLine1;
  }

  if (dto.addressLine2 !== undefined) {
    data.addressLine2 = dto.addressLine2;
  }

  if (dto.city !== undefined) {
    data.city = dto.city;
  }

  if (dto.stateProvince !== undefined) {
    data.stateProvince = dto.stateProvince;
  }

  if (dto.postalCode !== undefined) {
    data.postalCode = dto.postalCode;
  }

  if (dto.countryCode !== undefined) {
    data.countryCode = dto.countryCode;
  }

  return data;
}
