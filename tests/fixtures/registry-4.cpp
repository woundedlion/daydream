// solids.h defines no SEED_TRUNCATED_TETRAHEDRON. Paste the constant and its
// static_assert beside the other SEED_* constants.
inline constexpr uint8_t SEED_TRUNCATED_TETRAHEDRON =
    static_cast<uint8_t>(BaseMesh::TRUNCATED_TETRAHEDRON);
static_assert(
    std::string_view(simple_registry[SEED_TRUNCATED_TETRAHEDRON].name) ==
    "truncatedTetrahedron");

/** Step table for truncatedTetrahedron_kis_gyro. */
inline constexpr OpStep TRUNCATED_TETRAHEDRON_KIS_GYRO_STEPS[] = {
    {Op::KIS},
    {Op::GYRO},
};
/** Recipe mirror of IslamicStarPatterns::truncatedTetrahedron_kis_gyro. */
inline constexpr Recipe TRUNCATED_TETRAHEDRON_KIS_GYRO_RECIPE = make_recipe(
    SEED_TRUNCATED_TETRAHEDRON, TRUNCATED_TETRAHEDRON_KIS_GYRO_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail; the README registry table counts the entry too.
    {"truncatedTetrahedron_kis_gyro",
     IslamicStarPatterns::truncatedTetrahedron_kis_gyro, Category::Complex,
     &TRUNCATED_TETRAHEDRON_KIS_GYRO_RECIPE},
