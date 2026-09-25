// solids.h defines no SEED_TRUNCATED_CUBOCTAHEDRON. Paste the constant and its
// static_assert beside the other SEED_* constants.
inline constexpr uint8_t SEED_TRUNCATED_CUBOCTAHEDRON =
    static_cast<uint8_t>(BaseMesh::TRUNCATED_CUBOCTAHEDRON);
static_assert(
    std::string_view(simple_registry[SEED_TRUNCATED_CUBOCTAHEDRON].name) ==
    "truncatedCuboctahedron");

/** Step table for truncatedCuboctahedron_truncate33_truncate33_truncate33. */
inline constexpr OpStep
    TRUNCATED_CUBOCTAHEDRON_TRUNCATE33_TRUNCATE33_TRUNCATE33_STEPS[] = {
        {Op::TRUNCATE, 0.33f},
        {Op::TRUNCATE, 0.33f},
        {Op::TRUNCATE, 0.33f},
};
/**
 * Recipe mirror of
 * IslamicStarPatterns::truncatedCuboctahedron_truncate33_truncate33_truncate33.
 */
inline constexpr Recipe
    TRUNCATED_CUBOCTAHEDRON_TRUNCATE33_TRUNCATE33_TRUNCATE33_RECIPE =
        make_recipe(
            SEED_TRUNCATED_CUBOCTAHEDRON,
            TRUNCATED_CUBOCTAHEDRON_TRUNCATE33_TRUNCATE33_TRUNCATE33_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail; the README registry table counts the entry too.
    {"truncatedCuboctahedron_truncate33_truncate33_truncate33",
     IslamicStarPatterns::
         truncatedCuboctahedron_truncate33_truncate33_truncate33,
     Category::Complex,
     &TRUNCATED_CUBOCTAHEDRON_TRUNCATE33_TRUNCATE33_TRUNCATE33_RECIPE},
