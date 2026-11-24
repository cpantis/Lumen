/**
 * ROS 2 message definitions (ros2msg, with dependencies) used by the synthetic
 * recording generator. Same text layout as `ros2 bag record` writes into MCAP.
 */
const SEP = "\n================================================================================\n";

const TIME = "MSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec";
const HEADER = "MSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id";
const VEC3 = "MSG: geometry_msgs/Vector3\nfloat64 x\nfloat64 y\nfloat64 z";
const QUAT = "MSG: geometry_msgs/Quaternion\nfloat64 x 0\nfloat64 y 0\nfloat64 z 0\nfloat64 w 1";
const ROI = "MSG: sensor_msgs/RegionOfInterest\nuint32 x_offset\nuint32 y_offset\nuint32 height\nuint32 width\nbool do_rectify";
const POINTFIELD =
  "MSG: sensor_msgs/PointField\nuint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count";
const TRANSFORM = "MSG: geometry_msgs/Transform\nVector3 translation\nQuaternion rotation";
const TSTAMPED = "MSG: geometry_msgs/TransformStamped\nstd_msgs/Header header\nstring child_frame_id\nTransform transform";

const join = (root: string, ...deps: string[]) => [root, ...deps].join(SEP);

export const SCHEMAS: Record<string, string> = {
  "sensor_msgs/msg/Image": join(
    "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data",
    HEADER,
    TIME,
  ),
  "sensor_msgs/msg/CameraInfo": join(
    "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\nRegionOfInterest roi",
    HEADER,
    TIME,
    ROI,
  ),
  "sensor_msgs/msg/Imu": join(
    "std_msgs/Header header\ngeometry_msgs/Quaternion orientation\nfloat64[9] orientation_covariance\ngeometry_msgs/Vector3 angular_velocity\nfloat64[9] angular_velocity_covariance\ngeometry_msgs/Vector3 linear_acceleration\nfloat64[9] linear_acceleration_covariance",
    HEADER,
    TIME,
    QUAT,
    VEC3,
  ),
  "sensor_msgs/msg/PointCloud2": join(
    "std_msgs/Header header\nuint32 height\nuint32 width\nPointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense",
    HEADER,
    TIME,
    POINTFIELD,
  ),
  "tf2_msgs/msg/TFMessage": join("geometry_msgs/TransformStamped[] transforms", TSTAMPED, HEADER, TIME, TRANSFORM, VEC3, QUAT),
};
