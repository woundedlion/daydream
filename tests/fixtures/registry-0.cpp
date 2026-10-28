// solids.h defines no SEED_CUBE.
// Paste this beside the other SEED_* constants.
/// simple_registry index of the cube seed.
inline constexpr uint8_t SEED_CUBE = static_cast<uint8_t>(BaseMesh::CUBE);

// clang-format off
/** Step table for cube_truncate33. */
inline constexpr OpStep CUBE_TRUNCATE33_STEPS[] = {
    {Op::TRUNCATE, 0.33f},
};
// clang-format on
/** Recipe mirror of IslamicStarPatterns::cube_truncate33. */
inline constexpr Recipe CUBE_TRUNCATE33_RECIPE =
    make_recipe(SEED_CUBE, CUBE_TRUNCATE33_STEPS);

// Append this Entry to islamic_registry.
    {"cube_truncate33", IslamicStarPatterns::cube_truncate33, Category::COMPLEX,
     &CUBE_TRUNCATE33_RECIPE},
