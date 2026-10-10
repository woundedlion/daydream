// solids.h defines no SEED_TRUNCATED_TETRAHEDRON. Paste the constant and its
// static_assert beside the other SEED_* constants.
/// simple_registry index of the truncated tetrahedron seed.
inline constexpr uint8_t SEED_TRUNCATED_TETRAHEDRON =
    static_cast<uint8_t>(BaseMesh::TRUNCATED_TETRAHEDRON);
static_assert(
    std::string_view(simple_registry[SEED_TRUNCATED_TETRAHEDRON].name) ==
    "truncatedTetrahedron");

// clang-format off
/** Step table for truncatedTetrahedron_kis_gyro. */
inline constexpr OpStep TRUNCATED_TETRAHEDRON_KIS_GYRO_STEPS[] = {
    {Op::KIS},
    {Op::GYRO},
};
// clang-format on
/** Recipe mirror of IslamicStarPatterns::truncatedTetrahedron_kis_gyro. */
inline constexpr Recipe TRUNCATED_TETRAHEDRON_KIS_GYRO_RECIPE = make_recipe(
    SEED_TRUNCATED_TETRAHEDRON, TRUNCATED_TETRAHEDRON_KIS_GYRO_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail.
    {"truncatedTetrahedron_kis_gyro",
     IslamicStarPatterns::truncatedTetrahedron_kis_gyro, Category::Complex,
     &TRUNCATED_TETRAHEDRON_KIS_GYRO_RECIPE},
