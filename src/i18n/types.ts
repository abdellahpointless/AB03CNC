/**
 * The Turkish (or any other) resources must have exactly the same keys as the English ones.
 * `Translation<typeof en>` turns every English string into "some string", so a missing or
 * misspelled key in a translation is a compile error.
 */
export type Translation<T> = { [K in keyof T]: T[K] extends string ? string : Translation<T[K]> };
