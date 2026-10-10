// solids.h defines no SEED_CUBE. Paste the constant and its
// static_assert beside the other SEED_* constants.
/// simple_registry index of the cube seed.
inline constexpr uint8_t SEED_CUBE = static_cast<uint8_t>(BaseMesh::CUBE);
static_assert(std::string_view(simple_registry[SEED_CUBE].name) == "cube");

// clang-format off
/** Step table for cube_truncate33. */
inline constexpr OpStep CUBE_TRUNCATE33_STEPS[] = {
    {Op::TRUNCATE, 0.33f},
};
// clang-format on
/** Recipe mirror of IslamicStarPatterns::cube_truncate33. */
inline constexpr Recipe CUBE_TRUNCATE33_RECIPE =
    make_recipe(SEED_CUBE, CUBE_TRUNCATE33_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail.
    {"cube_truncate33", IslamicStarPatterns::cube_truncate33, Category::Complex,
     &CUBE_TRUNCATE33_RECIPE},
