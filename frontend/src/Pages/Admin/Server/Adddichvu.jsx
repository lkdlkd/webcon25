'use client';
import { loadingg } from "@/JS/Loading";
import { createServer, getServicesFromSmm, getAllSmmPartners } from "@/Utils/api";
import { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Table from "react-bootstrap/Table";
import Select from "react-select";
import { toast } from "react-toastify";
import { useOutletContext, useNavigate } from "react-router-dom";

export default function Adddichvu() {
  const navigate = useNavigate();
  const { categories: cate } = useOutletContext();
  const [categories, setCategories] = useState([]);
  const token = localStorage.getItem("token") || "";
  const [formData, setFormData] = useState({
    type: "",
    category: "",
    maychu: "",
    name: "",
    description: "",
    DomainSmm: "",
    serviceId: "",
    serviceName: "",
    min: "",
    max: "",
    rate: "",
    ratevip: "",
    rateDistributor: "",
    originalRate: "",
    getid: "off",
    comment: "off",
    reaction: "off",
    matlive: "off",
    refil: "off",
    cancel: "off",
    ordertay: false,
    isActive: true,
  });

  const [smmPartners, setSmmPartners] = useState([]);
  const [services, setServices] = useState([]);
  const [serviceError, setServiceError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingServices, setLoadingServices] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedServices, setSelectedServices] = useState([]);
  const [quickAddMode, setQuickAddMode] = useState(false);

  // Common styles for react-select to fix z-index issues
  const selectStyles = {
    control: (base) => ({ ...base, borderRadius: '8px', boxShadow: 'none', borderColor: '#e9ecef' }),
    menuPortal: (base) => ({ ...base, zIndex: 9999 }),
    menu: (base) => ({ ...base, zIndex: 9999 })
  };

  const dedupeByServiceId = (list) => {
    const map = new Map();
    for (const s of list) map.set(s.service, s);
    return Array.from(map.values());
  };

  const toggleServiceSelection = (svc) => {
    setSelectedServices((prev) => {
      const exists = prev.some((s) => s.service === svc.service);
      return exists ? prev.filter((s) => s.service !== svc.service) : [...prev, svc];
    });
  };

  const setServiceChecked = (svc, checked) => {
    setSelectedServices((prev) => {
      const exists = prev.some((s) => s.service === svc.service);
      if (checked && !exists) return [...prev, svc];
      if (!checked && exists) return prev.filter((s) => s.service !== svc.service);
      return prev;
    });
  };

  useEffect(() => {
    if (cate && Array.isArray(cate)) {
      setCategories(cate);
    } else {
      setCategories([]);
    }
  }, [cate]);

  useEffect(() => {
    const fetchSmmPartners = async () => {
      try {
        loadingg("Đang tải đối tác SMM...", true, 9999999);
        const partners = await getAllSmmPartners(token);
        setSmmPartners(Array.isArray(partners) ? partners : partners?.data || []);
      } catch (error) {
        toast.error("Không thể tải danh sách đối tác SMM!");
      } finally {
        loadingg("Đang tải...", false);
      }
    };
    fetchSmmPartners();
  }, [token]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({
      ...formData,
      [name]:
        name === "min" || name === "max" || name === "rate" || name === "ratevip" || name === "rateDistributor"
          ? value === ""
            ? ""
            : Number(value)
          : value,
    });
  };

  const handleServiceChange = (e) => {
    const id = e.target.value;
    const svc = services.find((s) => String(s.service) === id);
    const partner = smmPartners.find((p) => String(p._id) === String(formData.DomainSmm));
    const tigia = partner?.tigia || 1;

    if (svc) {
      setFormData({
        ...formData,
        serviceId: svc.service,
        serviceName: svc.name,
        min: svc.min || "",
        max: svc.max || "",
        rate: svc.rate * tigia || "",
        ratevip: svc.rate * tigia || "",
        rateDistributor: svc.rate * tigia || "",
        originalRate: svc.rate * tigia || "",
        category: svc.category || "",
      });
      setSelectedCategory(svc.category || "");
    } else {
      setFormData({
        ...formData,
        serviceId: id,
        serviceName: "",
        min: "",
        max: "",
        rate: "",
        ratevip: "",
        rateDistributor: "",
        originalRate: "",
        category: "",
      });
      setSelectedCategory("");
    }
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();

    if (!formData.type) {
      toast.error("Vui lòng chọn Nền tảng!");
      return;
    }
    if (!formData.category) {
      toast.error("Vui lòng chọn Danh mục!");
      return;
    }

    if (!formData.ordertay) {
      if (!formData.DomainSmm) {
        toast.error("Vui lòng chọn Domain SMM!");
        return;
      }
      if (!quickAddMode && !formData.serviceId) {
        toast.error("Vui lòng chọn dịch vụ từ danh sách!");
        return;
      }
    }

    if (formData.ordertay) {
      // Manual Order Logic
      if (!formData.name || formData.name.trim() === "") {
        toast.error("Vui lòng nhập Tên dịch vụ!");
        return;
      }
      // Manual order validation continues below
    }

    // Common validations (Only apply if NOT in Quick Add API mode)
    // Because in Quick Add API mode, Pricing card is hidden and values come from selected services
    if (!quickAddMode || formData.ordertay) {
      if (formData.min === "" || formData.min < 0) {
        toast.error("Vui lòng nhập Min hợp lệ!");
        return;
      }
      if (formData.max === "" || formData.max < 0) {
        toast.error("Vui lòng nhập Max hợp lệ!");
        return;
      }
      if (formData.rate < 0) {
        toast.error("Giá Thành Viên không được âm!");
        return;
      }
      if (formData.ratevip < 0) {
        toast.error("Giá Đại Lý không được âm!");
        return;
      }
      if (formData.rateDistributor < 0) {
        toast.error("Giá Nhà Phân Phối không được âm!");
        return;
      }
      if (Number(formData.min) > Number(formData.max)) {
        toast.error("Giá trị Min không được lớn hơn Max!");
        return;
      }
    }

    let finalFormData = { ...formData };
    if (formData.ordertay) {
      finalFormData = {
        ...formData,
        serviceName: formData.name,
        originalRate: formData.rateDistributor, // Or 0
      };
    }

    setLoading(true);
    loadingg("Đang thêm dịch vụ...", true, 9999999);
    try {
      if (!formData.ordertay && quickAddMode && selectedServices.length > 0) {
        // Quick Add Mode Logic (Only for API SMM)
        const uniqueSelected = dedupeByServiceId(selectedServices);
        await Promise.all(
          uniqueSelected.map(async (service) => {
            const partner = smmPartners.find((p) => String(p._id) === String(formData.DomainSmm));
            const tigia = partner?.tigia || 1;
            const ptgia = partner?.price_update || 0;
            const baseRate = service.rate * tigia;
            const finalRate = Math.ceil(baseRate * 10000 + (baseRate * ptgia) / 100 * 10000) / 10000;

            const VipRate = Math.ceil(baseRate * 10000 + (baseRate * partner.price_updateVip) / 100 * 10000) / 10000;
            const DistributorRate = Math.ceil(baseRate * 10000 + (baseRate * partner.price_updateDistributor) / 100 * 10000) / 10000;
            const payload = {
              ...finalFormData,
              serviceId: service.service,
              serviceName: service.name,
              name: service.name,
              min: service.min || 0,
              max: service.max || 0,
              rate: finalRate,
              ratevip: VipRate,
              rateDistributor: DistributorRate,
              originalRate: service.rate * tigia,
              description: finalFormData.description ? finalFormData.description.replace(/\n/g, '\\n') : "",
            };
            await createServer(payload, token);
          })
        );
      } else {
        // Single Add Logic (Manual or API SMM Single)
        const payloadData = {
          ...finalFormData,
          description: finalFormData.description ? finalFormData.description.replace(/\n/g, '\\n') : "",
        };
        await createServer(payloadData, token);
      }
      toast.success("Dịch vụ đã được thêm thành công!");
      navigate('/admin/server');
    } catch (error) {
      toast.error("Lỗi khi thêm dịch vụ. Vui lòng kiểm tra lại!");
    } finally {
      setLoading(false);
      loadingg("Đang tải...", false);
    }
  };

  const filteredCategories = categories.filter(
    (category) => category.platforms_id?._id === selectedPlatform
  );

  const uniqueCategories = Array.from(
    new Set(services.map((service) => service.category))
  ).filter((category) => category);

  const filteredServices = services.filter(
    (service) => service.category === selectedCategory
  );

  const uniquePlatforms = categories
    .map((category) => category.platforms_id)
    .filter(
      (platform, index, self) =>
        platform && index === self.findIndex((p) => p._id === platform._id)
    );

  const platformOptions = uniquePlatforms.map((platform) => ({
    value: platform._id,
    label: platform.name,
    platform,
  }));

  const categoryOptions = filteredCategories.map((category) => ({
    value: category._id,
    label: category.name,
    category,
  }));

  const domainOptions = smmPartners.map((partner) => ({
    value: partner._id,
    label: partner.name,
    partner,
  }));

  const doanhmucOptions = uniqueCategories.map((category) => ({
    value: category,
    label: category || "Không có danh mục",
  }));

  const serviceOptions = filteredServices.map((service) => ({
    value: service.service,
    label: service.name,
    service,
  }));

  const selectedPlatformOption = platformOptions.find(
    (opt) => opt.value === selectedPlatform
  ) || null;

  const selectedCategoryOption = categoryOptions.find(
    (opt) => opt.value === formData.category
  ) || null;

  const selectedDomainOption = domainOptions.find(
    (opt) => String(opt.value) === String(formData.DomainSmm)
  ) || null;

  const selectedDoanhmucOption = doanhmucOptions.find(
    (opt) => opt.value === selectedCategory
  ) || null;

  const selectedServiceOption = serviceOptions.find(
    (opt) => String(opt.value) === String(formData.serviceId)
  ) || null;

  return (
    <div className="container-fluid py-4" style={{ backgroundColor: '#fcfcfc' }}>
      {/* Header */}
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h4 className="fw-bold text-dark m-0">
            <i className="fas fa-plus-circle text-primary me-2"></i>Thêm Mới Dịch Vụ
          </h4>
          <p className="text-muted small m-0">Quản lý và cấu hình dịch vụ</p>
        </div>
        <button className="btn btn-outline-secondary btn-sm px-3 shadow-sm rounded-pill font-weight-bold" onClick={() => navigate('/admin/server')}>
          <i className="fas fa-arrow-left me-1"></i> Quay lại
        </button>
      </div>

      <form onSubmit={handleAddSubmit}>

        {/* TOP SETTINGS BAR */}
        <div className="card shadow-sm border-0 rounded-4 mb-4 bg-white">
          <div className="card-body p-4">
            <div className="row g-4">
              {/* Mode Section */}
              <div className="col-md-6 border-end">
                <h6 className="fw-bold text-dark mb-3"><i className="fas fa-layer-group me-2 text-primary"></i>Chế độ thêm</h6>
                <div className="d-flex gap-3">
                  <div
                    className={`p-3 rounded-3 border w-100 text-center cursor-pointer ${!quickAddMode ? 'bg-primary-subtle border-primary text-primary' : 'bg-light border-light'}`}
                    onClick={() => setQuickAddMode(false)}
                    style={{ cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    <div className="fw-bold"><i className="fas fa-plus me-1"></i> Thêm lẻ</div>
                    <small style={{ fontSize: '0.75rem' }}>Từng dịch vụ một</small>
                  </div>

                  {/* Disable Quick Add if Order Tay is selected */}
                  <div
                    className={`p-3 rounded-3 border w-100 text-center ${quickAddMode ? 'bg-primary-subtle border-primary text-primary' : 'bg-light border-light'} ${formData.ordertay ? 'opacity-50' : 'cursor-pointer'}`}
                    onClick={() => !formData.ordertay && setQuickAddMode(true)}
                    style={{ cursor: formData.ordertay ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}
                    title={formData.ordertay ? "Chế độ thêm nhiều chỉ áp dụng cho API SMM" : ""}
                  >
                    <div className="fw-bold"><i className="fas fa-th-list me-1"></i> Thêm nhiều</div>
                    <small style={{ fontSize: '0.75rem' }}>Hàng loạt (Chỉ API)</small>
                  </div>
                </div>
              </div>

              {/* Type Section */}
              <div className="col-md-6">
                <h6 className="fw-bold text-dark mb-3"><i className="fas fa-cogs me-2 text-warning"></i>Loại dịch vụ</h6>
                <div className="d-flex gap-3">
                  <div
                    className={`p-3 rounded-3 border w-100 text-center cursor-pointer ${!formData.ordertay ? 'bg-warning-subtle border-warning text-dark font-weight-bold' : 'bg-light border-light'}`}
                    onClick={() => {
                      setFormData({ ...formData, ordertay: false });
                    }}
                    style={{ cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    <div className="fw-bold"><i className="fas fa-cloud-download-alt me-1"></i> API SMM</div>
                    <small style={{ fontSize: '0.75rem' }}>Lấy từ nguồn khác</small>
                  </div>
                  <div
                    className={`p-3 rounded-3 border w-100 text-center cursor-pointer ${formData.ordertay ? 'bg-warning-subtle border-warning text-dark font-weight-bold' : 'bg-light border-light'}`}
                    onClick={() => {
                      setFormData({ ...formData, ordertay: true, DomainSmm: "", serviceId: "" });
                      setQuickAddMode(false); // FORCE SINGLE ADD
                      setServices([]);
                      setSelectedCategory("");
                    }}
                    style={{ cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    <div className="fw-bold"><i className="fas fa-hand-paper me-1"></i> Đơn tay</div>
                    <small style={{ fontSize: '0.75rem' }}>Tự xử lý thủ công</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="row g-4">

          {/* Main Column */}
          <div className="col-lg-9">

            {/* 1. Basic Information */}
            <div className="card shadow-sm border-0 rounded-4 mb-4" style={{ zIndex: 10 }}>
              <div className="card-header bg-white border-bottom-0 pt-4 px-4 pb-0">
                <h6 className="fw-bold text-dark mb-0 d-flex align-items-center">
                  <span className="bg-primary text-white rounded-circle d-flex align-items-center justify-content-center me-2" style={{ width: '30px', height: '30px', fontSize: '0.8rem' }}>1</span>
                  Thông tin cơ bản
                </h6>
              </div>
              <div className="card-body p-4">
                <div className="row g-4">
                  <div className="col-md-6">
                    <label className="form-label fw-bold text-muted small text-uppercase">Nền tảng <span className="text-danger">*</span></label>
                    <Select
                      value={selectedPlatformOption}
                      onChange={(option) => {
                        setSelectedPlatform(option ? option.value : "");
                        if (option && option.platform) {
                          setFormData((prev) => ({ ...prev, type: option.platform._id }));
                        }
                      }}
                      options={platformOptions}
                      placeholder="Chọn nền tảng..."
                      className="react-select-container"
                      classNamePrefix="react-select"
                      menuPortalTarget={document.body}
                      styles={selectStyles}
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label fw-bold text-muted small text-uppercase">Danh mục <span className="text-danger">*</span></label>
                    <Select
                      value={selectedCategoryOption}
                      onChange={(option) => setFormData({ ...formData, category: option ? option.value : "" })}
                      options={categoryOptions}
                      placeholder="Chọn danh mục..."
                      className="react-select-container"
                      classNamePrefix="react-select"
                      menuPortalTarget={document.body}
                      styles={selectStyles}
                    />
                  </div>

                  {/* Show full form fields if NOT quick add mode OR if Manual Order mode */}
                  {(!quickAddMode || formData.ordertay) && (
                    <>
                      <div className="col-md-6">
                        <label className="form-label fw-bold text-muted small text-uppercase">Máy chủ</label>
                        <input type="text" className="form-control rounded-3" name="maychu" list="svlist" value={formData.maychu} onChange={e => setFormData({ ...formData, maychu: e.target.value })} placeholder="Sv1" />
                        <datalist id="svlist"><option value="Sv1" /><option value="Sv2" /></datalist>
                      </div>
                      <div className="col-md-6">
                        <label className="form-label fw-bold text-muted small text-uppercase">Tên dịch vụ</label>
                        <input type="text" className="form-control rounded-3" name="name" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="Tên hiển thị..." />
                      </div>
                      <div className="col-12">
                        <label className="form-label fw-bold text-muted small text-uppercase">Mô tả</label>
                        <textarea className="form-control rounded-3" rows="3" value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} placeholder="Mô tả chi tiết..."></textarea>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 2. API Connection */}
            {!formData.ordertay && (
              <div className="card shadow-sm border-0 rounded-4 mb-4" style={{ zIndex: 9 }}>
                <div className="card-header bg-white border-bottom-0 pt-4 px-4 pb-0">
                  <h6 className="fw-bold text-dark mb-0 d-flex align-items-center">
                    <span className="bg-info text-white rounded-circle d-flex align-items-center justify-content-center me-2" style={{ width: '30px', height: '30px', fontSize: '0.8rem' }}>2</span>
                    Kết nối API SMM
                  </h6>
                </div>
                <div className="card-body p-4">
                  <div className="row g-4">
                    <div className="col-md-5">
                      <label className="form-label fw-bold text-muted small text-uppercase">Nguồn SMM <span className="text-danger">*</span></label>
                      <Select
                        value={selectedDomainOption}
                        onChange={async (option) => {
                          const domainId = option ? option.value : "";
                          setFormData({
                            ...formData,
                            DomainSmm: domainId,
                            serviceId: "", serviceName: "", originalRate: "", min: "", max: "", rate: "", ratevip: "", rateDistributor: "",
                          });
                          setServices([]);
                          setSelectedCategory("");
                          if (!option) return;
                          const partner = smmPartners.find((p) => String(p._id) === String(domainId));
                          if (!partner) return;
                          try {
                            setLoadingServices(true);
                            setServiceError("");
                            const servicesData = await getServicesFromSmm(partner._id, token);
                            if (servicesData && servicesData.data) {
                              if (Array.isArray(servicesData.data)) {
                                setServices(servicesData.data);
                              } else if (servicesData.data.error) {
                                setServices([]);
                                setServiceError(servicesData.data.error);
                              }
                            } else {
                              setServices([]);
                            }
                          } catch (error) {
                            toast.error(`${error.message}`);
                            setServiceError(error.message);
                          } finally {
                            setLoadingServices(false);
                          }
                        }}
                        options={domainOptions}
                        placeholder="Chọn đối tác SMM..."
                        isLoading={loadingServices}
                        className="react-select-container"
                        classNamePrefix="react-select"
                        menuPortalTarget={document.body}
                        styles={selectStyles}
                      />
                    </div>
                    <div className="col-md-7">
                      <label className="form-label fw-bold text-muted small text-uppercase">Lọc theo danh mục API</label>
                      <Select
                        value={selectedDoanhmucOption}
                        onChange={(option) => setSelectedCategory(option ? option.value : "")}
                        options={doanhmucOptions}
                        placeholder="Lọc danh mục..."
                        isClearable
                        isDisabled={loadingServices || !services.length}
                        className="react-select-container"
                        classNamePrefix="react-select"
                        menuPortalTarget={document.body}
                        styles={selectStyles}
                      />
                      {serviceError && <div className="text-danger small mt-1"><i className="fas fa-exclamation-triangle"></i> {serviceError}</div>}
                    </div>

                    {!quickAddMode && (
                      <>
                        <div className="col-md-8">
                          <label className="form-label fw-bold text-muted small text-uppercase">Chọn dịch vụ API</label>
                          <Select
                            value={selectedServiceOption}
                            onChange={(option) => {
                              if (!option) {
                                setFormData({ ...formData, serviceId: "", serviceName: "", min: "", max: "", rate: "", ratevip: "", rateDistributor: "", originalRate: "", category: "" });
                                setSelectedCategory("");
                                return;
                              }
                              const svc = services.find((s) => String(s.service) === String(option.value));
                              const partner = smmPartners.find((p) => String(p._id) === String(formData.DomainSmm));
                              const tigia = partner?.tigia || 1;
                              const ptgia = partner?.price_update || 0;
                              const ptvip = partner?.price_updateVip || 0;
                              const ptdistributor = partner?.price_updateDistributor || 0;
                              const baseRate = svc.rate * tigia;
                              const finalRate = Math.ceil(baseRate * 10000 + (baseRate * ptgia) / 100 * 10000) / 10000;
                              const VipRate = Math.ceil(baseRate * 10000 + (baseRate * ptvip) / 100 * 10000) / 10000;
                              const DistributorRate = Math.ceil(baseRate * 10000 + (baseRate * ptdistributor) / 100 * 10000) / 10000;

                              if (svc) {
                                setFormData({
                                  ...formData,
                                  serviceId: svc.service,
                                  serviceName: svc.name,
                                  min: svc.min || "",
                                  max: svc.max || "",
                                  rate: finalRate || "",
                                  ratevip: VipRate || "",
                                  rateDistributor: DistributorRate || "",
                                  originalRate: svc.rate * tigia || "",
                                  category: svc.category || "",
                                });
                                setSelectedCategory(svc.category || "");
                              }
                            }}
                            options={serviceOptions}
                            placeholder="Tìm kiếm dịch vụ..."
                            noOptionsMessage={() => "Không tìm thấy dịch vụ"}
                            className="react-select-container"
                            classNamePrefix="react-select"
                            menuPortalTarget={document.body}
                            styles={selectStyles}
                          />
                        </div>
                        <div className="col-md-4">
                          <label className="form-label fw-bold text-muted small text-uppercase">Service ID (Nhập tay)</label>
                          <input type="text" className="form-control rounded-3" name="serviceId" value={formData.serviceId} onChange={handleServiceChange} placeholder="Nhập ID thủ công" />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 3. Pricing */}
            {(!quickAddMode || formData.ordertay) && (
              <div className="card shadow-sm border-0 rounded-4 mb-4" style={{ zIndex: 8 }}>
                <div className="card-header bg-white border-bottom-0 pt-4 px-4 pb-0">
                  <h6 className="fw-bold text-dark mb-0 d-flex align-items-center">
                    <span className="bg-success text-white rounded-circle d-flex align-items-center justify-content-center me-2" style={{ width: '30px', height: '30px', fontSize: '0.8rem' }}>3</span>
                    Giá & Giới hạn
                  </h6>
                </div>
                <div className="card-body p-4">
                  <div className="row g-4">
                    <div className="col-md-4">
                      <label className="form-label fw-bold text-muted small text-uppercase">Giá Thành Viên</label>
                      <div className="input-group">
                        <input type="number" className="form-control rounded-start-3" name="rate" value={formData.rate} onChange={handleChange} placeholder="0" step="0.0001" />
                        <span className="input-group-text bg-white border-start-0 rounded-end-3">đ</span>
                      </div>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label fw-bold text-muted small text-uppercase">Giá Đại Lý</label>
                      <div className="input-group">
                        <input type="number" className="form-control rounded-start-3" name="ratevip" value={formData.ratevip} onChange={handleChange} placeholder="0" step="0.0001" />
                        <span className="input-group-text bg-white border-start-0 rounded-end-3">đ</span>
                      </div>
                    </div>
                    <div className="col-md-4">
                      <label className="form-label fw-bold text-muted small text-uppercase">Giá NPP</label>
                      <div className="input-group">
                        <input type="number" className="form-control rounded-start-3" name="rateDistributor" value={formData.rateDistributor} onChange={handleChange} placeholder="0" step="0.0001" />
                        <span className="input-group-text bg-white border-start-0 rounded-end-3">đ</span>
                      </div>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label fw-bold text-muted small text-uppercase">Min Order</label>
                      <input type="number" className="form-control rounded-3" name="min" value={formData.min} onChange={handleChange} placeholder="100" />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label fw-bold text-muted small text-uppercase">Max Order</label>
                      <input type="number" className="form-control rounded-3" name="max" value={formData.max} onChange={handleChange} placeholder="1000000" />
                    </div>

                    {!formData.ordertay && (
                      <div className="col-12">
                        <div className="p-3 bg-light rounded-3 d-flex align-items-center justify-content-center">
                          <small className="text-secondary fw-bold text-uppercase me-2">Giá gốc tham khảo:</small>
                          <span className="fs-5 fw-bold text-dark">{formData.originalRate || 0} đ</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Quick Add Table */}
            {quickAddMode && !formData.ordertay && (
              <>
                <div className="card shadow-sm border-0 rounded-4 mb-4" style={{ zIndex: 7 }}>
                  <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                    <h6 className="fw-bold text-dark m-0"><i className="fas fa-list me-2 text-primary"></i>Chọn dịch vụ từ SMM</h6>
                    <span className="badge bg-soft-primary text-primary rounded-pill">{filteredServices.length} dịch vụ</span>
                  </div>
                  <div className="card-body p-0">
                    <div className="table-responsive" style={{ maxHeight: '500px' }}>
                      <Table hover className="align-middle mb-0 table-striped">
                        <thead className="bg-light sticky-top text-secondary small text-uppercase" style={{ zIndex: 5 }}>
                          <tr>
                            <th className="text-center" width="50">
                              <input className="form-check-input" type="checkbox"
                                onChange={(e) => setSelectedServices(e.target.checked ? filteredServices : [])}
                                checked={filteredServices.length > 0 && selectedServices.length === filteredServices.length}
                              />
                            </th>
                            <th className="fw-bold">ID</th>
                            <th className="fw-bold">Tên Dịch Vụ</th>
                            <th className="text-end fw-bold">Giá Gốc (đ)</th>
                            <th className="text-center fw-bold">Min - Max</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredServices.length > 0 ? filteredServices.map(svc => {
                            const partner = smmPartners.find(p => String(p._id) === String(formData.DomainSmm));
                            const tigia = partner?.tigia || 1;
                            const isSel = selectedServices.some(s => s.service === svc.service);
                            return (
                              <tr key={svc.service} onClick={() => toggleServiceSelection(svc)} className={isSel ? "table-active" : ""} style={{ cursor: 'pointer' }}>
                                <td className="text-center">
                                  <input className="form-check-input" type="checkbox" checked={isSel} onChange={(e) => { e.stopPropagation(); setServiceChecked(svc, e.target.checked); }} />
                                </td>
                                <td><span className="badge bg-white text-dark border">{svc.service}</span></td>
                                <td><div className="text-wrap text-dark fw-500" style={{ minWidth: '250px' }}>{svc.name}</div></td>
                                <td className="text-end fw-bold text-primary">{(svc.rate * tigia).toFixed(4)}</td>
                                <td className="text-center small text-muted font-monospace">{svc.min} - {svc.max}</td>
                              </tr>
                            )
                          }) : (
                            <tr><td colSpan="5" className="text-center py-5 text-muted">Vui lòng chọn Nguồn SMM và Danh mục để xem dịch vụ</td></tr>
                          )}
                        </tbody>
                      </Table>
                    </div>
                  </div>
                </div>

                {/* Selected Services Table Summary */}
                {selectedServices.length > 0 && (
                  <div className="card shadow-sm border-0 rounded-4 mb-4" style={{ zIndex: 6 }}>
                    <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                      <h6 className="fw-bold text-success m-0"><i className="fas fa-check-circle me-2"></i>Danh sách dịch vụ đã chọn ({selectedServices.length})</h6>
                      <button type="button" className="btn btn-outline-danger btn-sm rounded-pill" onClick={() => setSelectedServices([])}><i className="fas fa-trash me-1"></i> Bỏ chọn tất cả</button>
                    </div>
                    <div className="card-body p-0">
                      <div className="table-responsive" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                        <Table bordered hover className="mb-0">
                          <thead className="bg-success-subtle text-success small text-uppercase sticky-top">
                            <tr>
                              <th style={{ width: '80px' }} className="fw-bold">Mã</th>
                              <th className="fw-bold">Tên dịch vụ</th>
                              <th style={{ width: '220px' }} className="fw-bold">Giá tính toán</th>
                              <th style={{ width: '80px' }} className="fw-bold">Min</th>
                              <th style={{ width: '80px' }} className="fw-bold">Max</th>
                              <th style={{ width: '60px' }} className="fw-bold text-center"><i className="fas fa-trash-alt"></i></th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedServices.map((service, index) => {
                              const partner = smmPartners.find((p) => String(p._id) === String(formData.DomainSmm));
                              const tigia = partner?.tigia || 1;
                              const ptgia = partner?.price_update || 0;
                              const ptvip = partner?.price_updateVip || 0;
                              const ptdistributor = partner?.price_updateDistributor || 0;
                              const basePrice = (service.rate * tigia).toFixed(4);

                              const finalPrice = Math.ceil(basePrice * 10000 + (basePrice * ptgia) / 100 * 10000) / 10000;
                              const ratevip = Math.ceil(basePrice * 10000 + (basePrice * ptvip) / 100 * 10000) / 10000;
                              const rateDistributor = Math.ceil(basePrice * 10000 + (basePrice * ptdistributor) / 100 * 10000) / 10000;

                              return (
                                <tr key={index}>
                                  <td>
                                    <span className="badge bg-light text-dark border font-monospace">{service.service}</span>
                                  </td>
                                  <td>
                                    <div className="small fw-500 text-dark text-wrap" style={{ minWidth: '200px' }}>
                                      {service.name}
                                    </div>
                                  </td>
                                  <td>
                                    <div className="small" style={{ lineHeight: '1.4' }}>
                                      <div className="text-secondary">Gốc: {basePrice}</div>
                                      <div className="text-success fw-bold">TV: {finalPrice}</div>
                                      <div className="text-warning fw-bold">ĐL: {ratevip}</div>
                                      <div className="text-danger fw-bold">NPP: {rateDistributor}</div>
                                    </div>
                                  </td>
                                  <td className="small text-muted">{service.min}</td>
                                  <td className="small text-muted">{service.max}</td>
                                  <td className="text-center">
                                    <button
                                      type="button"
                                      className="btn btn-link text-danger p-0"
                                      onClick={() => toggleServiceSelection(service)}
                                      title="Xóa"
                                    >
                                      <i className="fas fa-times-circle fa-lg"></i>
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </Table>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {quickAddMode && formData.ordertay && (
              <div className="alert alert-info border-0 shadow-sm rounded-3">
                <i className="fas fa-magic me-2"></i>
                <strong>Chế độ thêm nhanh:</strong> Hệ thống sẽ tự động tạo Service ID và thiết lập giá mặc định.
              </div>
            )}

          </div>

          {/* Sidebar Column */}
          <div className="col-lg-3">
            <div className="sticky-top" style={{ top: '20px', zIndex: 11 }}>

              {/* Save Button Card */}
              <div className="card shadow-sm border-0 rounded-4 mb-3">
                <div className="card-body p-3">
                  <Button type="submit" variant="primary" className="w-100 fw-bold py-2 text-uppercase mb-2 rounded-pill shadow-sm" disabled={loading} style={{ background: 'linear-gradient(45deg, #007bff, #0056b3)', border: 'none' }}>
                    {loading ? <><i className="fas fa-spinner fa-spin me-2"></i>Đang xử lý...</> : <><i className="fas fa-save me-2"></i>Lưu Dịch Vụ</>}
                  </Button>
                  <div className="text-center small text-muted">
                    {formData.ordertay ? 'Chế độ đơn tay' : (quickAddMode ? 'Chế độ thêm hàng loạt' : 'Chế độ thêm lẻ (API)')}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
