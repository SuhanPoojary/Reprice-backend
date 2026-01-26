// middleware/adminMiddleware.js

exports.isAdmin = (req, res, next) => {
  if (req.user && req.user.userType === "admin") return next();

  return res.status(403).json({
    success: false,
    message: "Access denied. Admins only.",
  });
};
