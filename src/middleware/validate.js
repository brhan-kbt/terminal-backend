const { ZodError } = require('zod');

/**
 * Zod validation middleware factory.
 * Returns middleware that validates req.body against the provided Zod schema.
 * Returns 400 with Zod error details if validation fails.
 *
 * Usage: validate(myZodSchema)
 */
function validate(schema) {
  return function (req, res, next) {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: err.errors,
        });
      }
      next(err);
    }
  };
}

module.exports = validate;
