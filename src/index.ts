import { greet } from "./greet.ts";

const name = process.argv[2];
console.log(greet(name));
