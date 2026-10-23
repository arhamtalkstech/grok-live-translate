Look up the caller's user record by the email address on the account. Call it only after the caller has confirmed the email you read back.
The result is a list. An empty list means the email is not on file. Anything that is not a list, or contains "error", means the check failed: do not treat the caller as verified.
If the caller gave a last name and it differs from last_name in the result, the check failed.
