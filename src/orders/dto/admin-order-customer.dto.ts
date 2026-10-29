/**
 * The customer fields an administrator may see on an order.
 *
 * This is an explicit projection rather than a `User` row: `passwordHash`, login
 * metadata, status and any future credential column are absent from both the DTO
 * and the Prisma select that feeds it. The order already carries its own shipping
 * recipient snapshot, so the account record only has to identify who placed it.
 */
export class AdminOrderCustomerDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;

  static fromEntity(customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  }): AdminOrderCustomerDto {
    const dto = new AdminOrderCustomerDto();

    dto.id = customer.id;
    dto.firstName = customer.firstName;
    dto.lastName = customer.lastName;
    dto.email = customer.email;
    return dto;
  }
}
