import { createAuth } from "@youtube-biology-autogenerator/auth";
import { createDb } from "@youtube-biology-autogenerator/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);
