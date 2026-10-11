export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = "bad_request") => new ApiError(400, code, message);
export const forbidden = (message = "権限がありません") => new ApiError(403, "forbidden", message);
export const notFound = (message = "見つかりません") => new ApiError(404, "not_found", message);
export const conflict = (message, code = "conflict") => new ApiError(409, code, message);
